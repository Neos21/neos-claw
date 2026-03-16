import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ollama, type Message, type Tool, type ToolCall } from 'ollama';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export interface AgentTool {
  /** MCPのツール名 (例: "brave_search", "read_file") */
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: Array<string>;
  };
  /** ツールを実際に実行する関数。MCPClientから注入する */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface AgentCoreOptions {
  /** Ollama のホスト (デフォルト: http://localhost:11434) */
  ollamaHost?: string;
  /** 使用するモデル (デフォルト: qwen2.5:14b-instruct-q4_k_m) */
  model?: string;
  /** 登録するツール一覧 */
  tools?: Array<AgentTool>;
  /** システムプロンプト */
  systemPrompt?: string;
  /** tool call の最大ループ回数 (デフォルト: 10) */
  maxIterations?: number;
  /** デバッグログを出力するか */
  debug?: boolean;
}

export interface RunResult {
  /** エージェントの最終応答テキスト */
  text: string;
  /** 実行した tool call のログ */
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  /** 消費したイテレーション数 */
  iterations: number;
}


/** ToolProxy が確認待ちを伝えるためのプレフィックス */
export const CONFIRM_PREFIX = '__CONFIRM__:';

// AgentCore と ToolProxy の共通インターフェース
export interface Runner {
  getTools(): Array<AgentTool>;
  run(history: Array<Message>, userMessage: string, sessionId?: string): Promise<RunResult>;
}

// ----------------------------------------------------------------
// AgentCore
// ----------------------------------------------------------------

export class AgentCore {
  private ollama: Ollama;
  private model: string;
  private tools: Array<AgentTool>;
  private systemPrompt: string;
  private maxIterations: number;
  private debug: boolean;
  
  constructor(options: AgentCoreOptions = {}) {
    this.ollama = new Ollama({
      host: options.ollamaHost ?? 'http://localhost:11434'
    });
    this.model = options.model ?? 'qwen2.5:14b-instruct-q4_k_m';
    this.tools = options.tools ?? [];
    this.systemPrompt = options.systemPrompt ?? '';
    this.maxIterations = options.maxIterations ?? 10;
    this.debug = options.debug ?? false;
  }
  
  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------
  
  /**
   * 会話履歴を受け取り、エージェントのReActループを回して最終応答を返す。
   * 呼び出し側（session.ts）が履歴を管理する設計。
   * 
   * @param history - これまでの会話履歴（system メッセージは含まない）
   * @param userMessage - 今回のユーザーメッセージ
   * @returns 最終応答テキストと実行ログ
   */
  async run(history: Array<Message>, userMessage: string): Promise<RunResult> {
    // system + 過去履歴 + 今回のユーザーメッセージ
    const messages: Array<Message> = [
      { role: 'system', content: this.buildSystemPrompt() },
      ...history,
      { role: 'user', content: userMessage }
    ];
    this.log('=== SYSTEM PROMPT ===\n' + this.buildSystemPrompt());
    
    const toolCallLog: RunResult['toolCalls'] = [];
    let iterations = 0;
    
    this.log('▶ Starting ReAct loop', { model: this.model, tools: this.tools.map(t => t.name) });
    
    // ----------------------------------------------------------------
    // ReAct ループ: Reasoning → Action → Observation → 繰り返し
    // ----------------------------------------------------------------
    while(iterations < this.maxIterations) {
      iterations++;
      this.log(`\n[Iteration ${iterations}] Calling Ollama...`);
      
      const response = await this.ollama.chat({
        model: this.model,
        messages,
        tools: this.buildOllamaTools(),
        // ストリーミングなし（呼び出し側でストリームしたい場合は別メソッドを追加）
        stream: false
      });
      
      const assistantMessage = response.message;
      messages.push(assistantMessage);
      
      // tool call がなければ終了
      if(!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
        this.log('✅ No tool calls. Final answer:', assistantMessage.content);
        return {
          text: assistantMessage.content ?? '',
          toolCalls: toolCallLog,
          iterations
        };
      }
      
      // tool call がある場合は全て実行して結果を履歴に追加
      this.log('🔧 Tool calls:', assistantMessage.tool_calls.map(tc => tc.function.name));
      
      let confirmText: string | null = null;
      
      for(const toolCall of assistantMessage.tool_calls as Array<ToolCall>) {
        const result = await this.executeTool(toolCall);
        toolCallLog.push({
          name: toolCall.function.name,
          args: toolCall.function.arguments as Record<string, unknown>,
          result
        });
        
        // ToolProxy が確認待ちを返した場合はループを打ち切り、
        // 確認メッセージをそのまま最終回答として返す
        if(result.startsWith(CONFIRM_PREFIX)) {
          confirmText = result.slice(CONFIRM_PREFIX.length);
          break;
        }
        
        // tool result を履歴に追加
        // Ollama は tool_name フィールドが必要（ないとモデルが結果を判別できない）
        messages.push({
          role: 'tool',
          content: result,
          tool_name: toolCall.function.name
        } as Message);
      }
      
      if(confirmText != null) {
        this.log('⏸ Confirm required. Pausing ReAct loop.');
        return { text: confirmText, toolCalls: toolCallLog, iterations };
      }
    }
    
    // イテレーション上限に達した場合
    this.log('⚠️ Max iterations reached.');
    return {
      text: '申し訳ありません。処理が複雑すぎて完了できませんでした。もう少し簡単な指示に分割してみてください。',
      toolCalls: toolCallLog,
      iterations
    };
  }
  
  /**
   * ツールを動的に追加する（MCPClientからの登録用）
   */
  registerTool(tool: AgentTool): void {
    const existing = this.tools.findIndex(t => t.name === tool.name);
    if(existing !== -1) {
      this.tools[existing] = tool; // 上書き
    }
    else {
      this.tools.push(tool);
    }
    this.log(`🔌 Tool registered: ${tool.name}`);
  }
  
  /**
   * 登録済みツール一覧を返す
   */
  getTools(): Array<AgentTool> {
    return [...this.tools];
  }
  
  /**
   * システムプロンプトを差し替える（タスク種別ごとの切り替え用）
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
  
  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------
  
  /** AgentTool[] を Ollama の Tool[] 形式に変換 */
  private buildOllamaTools(): Array<Tool> {
    if(this.tools.length === 0) return [];
    return this.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }
  
  /** ツールを名前で検索して実行し、結果を文字列で返す */
  private async executeTool(toolCall: ToolCall): Promise<string> {
    const name = toolCall.function.name;
    const args = toolCall.function.arguments as Record<string, unknown>;
    const tool = this.tools.find(t => t.name === name);
    
    if(!tool) {
      const msg = `Tool not found: ${name}`;
      this.log(`❌ ${msg}`);
      return msg;
    }
    
    try {
      this.log(`  → Executing: ${name}`, args);
      const result = await tool.execute(args);
      this.log(`  ← Result: ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`);
      return result;
    }
    catch(err) {
      const msg = `Tool execution failed (${name}): ${err instanceof Error ? err.message : String(err)}`;
      this.log(`❌ ${msg}`);
      return msg;
    }
  }
  
  /**
   * agent/system-prompt.md を読み込み、{{TOOLS}} をツール一覧で置換して返す。
   * プロンプトの内容は .md ファイルだけで管理し、core.ts はロジックを持たない。
   */
  private buildSystemPrompt(): string {
    // systemPrompt が明示指定されていればそちらを使う（テスト用）
    if(this.systemPrompt !== '') return this.systemPrompt;
    
    const __filename = fileURLToPath(import.meta.url);
    const __dirname  = dirname(__filename);
    const promptPath = resolve(__dirname, 'system-prompt.md');
    
    let template: string;
    try {
      template = readFileSync(promptPath, 'utf-8');
    }
    catch {
      // ファイルが読めない場合はシンプルなフォールバック
      template = 'You are a helpful AI assistant. Always respond in the same language as the user.\n\n## Available Tools\n{{TOOLS}}';
    }
    
    const toolList = this.tools
      .map(t => `- ${t.name}: ${t.description}`)
      .join('\n');
    
    return template.replace('{{TOOLS}}', toolList);
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) {
      console.log(`[AgentCore] ${message}`, ...args);
    }
  }
}