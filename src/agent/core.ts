import { Ollama, type Message, type Tool, type ToolCall } from 'ollama';

export interface AgentTool {
  /** MCP のツール名 (例: `brave_search`・``read_file`) */
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; }>;
    required?: Array<string>;
  };
  /** ツールを実際に実行する関数・MCPClient から注入する */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface AgentCoreOptions {
  /** Ollama のホスト (デフォルト http://localhost:11434) */
  ollamaHost?: string;
  /** 使用するモデル (デフォルト qwen2.5:14b-instruct-q4_k_m) */
  model?: string;
  /** 登録するツール一覧 */
  tools?: Array<AgentTool>;
  /** システムプロンプト */
  systemPrompt?: string;
  /** Tool Call の最大ループ回数 (デフォルト 10) */
  maxIterations?: number;
  /** デバッグログを出力するか */
  debug?: boolean;
}

export interface RunResult {
  /** エージェントの最終応答テキスト */
  text: string;
  /** 実行した Tool Call のログ */
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string; }>;
  /** 消費したイテレーション数 */
  iterations: number;
}

export class AgentCore {
  private ollama: Ollama;
  private model: string;
  private tools: Array<AgentTool>;
  private systemPrompt: string;
  private maxIterations: number;
  private debug: boolean;
  
  constructor(options: AgentCoreOptions = {}) {
    this.ollama = new Ollama({
      host: options.ollamaHost ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434'
    });
    this.model = options.model ?? process.env.OLLAMA_MODEL ?? 'qwen2.5:14b-instruct-q4_k_m';
    this.tools = options.tools ?? [];
    this.systemPrompt =
      options.systemPrompt ??
      'You are a helpful AI assistant. Use the available tools when needed. Always respond in the same language as the user.';
    this.maxIterations = options.maxIterations ?? 10;
    this.debug = options.debug ?? false;
  }
  
  /**
   * 会話履歴を受け取り、エージェントの ReAct ループを回して最終応答を返す
   * 呼び出し側 (session.ts) が履歴を管理する設計
   * 
   * @param histories これまでの会話履歴 (System メッセージは含まない)
   * @param userMessage 今回のユーザメッセージ
   * @returns 最終応答テキストと実行ログ
   */
  public async run(histories: Array<Message>, userMessage: string): Promise<RunResult> {
    // System + 過去履歴 + 今回のユーザメッセージ
    const messages: Array<Message> = [
      { role: 'system', content: this.systemPrompt },
      ...histories,
      { role: 'user', content: userMessage }
    ];
    
    const toolCallLog: RunResult['toolCalls'] = [];
    let iterations = 0;
    
    this.log('▶ Starting ReAct Loop', { model: this.model, tools: this.tools.map((t) => t.name) });
    
    // ReAct ループ : Reasoning → Action → Observation → 繰り返し
    while(iterations < this.maxIterations) {
      iterations++;
      this.log(`\n[Iteration ${iterations}] Calling Ollama...`);
      
      const response = await this.ollama.chat({
        model: this.model,
        messages,
        tools: this.buildOllamaTools(),
        // ストリーミングなし (呼び出し側でストリームしたい場合は別メソッドを追加)
        stream: false
      });
      
      const assistantMessage = response.message;
      messages.push(assistantMessage);
      
      // Tool Call がなければ終了
      if(assistantMessage.tool_calls == null || assistantMessage.tool_calls.length === 0) {
        this.log('✅ No Tool Calls. Final Answer :', assistantMessage.content);
        return {
          text: assistantMessage.content ?? '',
          toolCalls: toolCallLog,
          iterations
        };
      }
      
      // Tool Call がある場合は全て実行して結果を履歴に追加
      this.log('🔧 Tool Calls :', assistantMessage.tool_calls.map((tc) => tc.function.name));
      
      for(const toolCall of assistantMessage.tool_calls as Array<ToolCall>) {
        const result = await this.executeTool(toolCall);
        toolCallLog.push({
          name: toolCall.function.name,
          args: toolCall.function.arguments as Record<string, unknown>,
          result
        });
        
        // Tool Result を履歴に追加（Ollama の tool_results 形式）
        messages.push({
          role: 'tool',
          content: result
        });
      }
    }
    
    // イテレーション上限に達した場合
    this.log('⚠️ Max Iterations Reached');
    return {
      text: '申し訳ありません。処理が複雑すぎて完了できませんでした。もう少し簡単な指示に分割してみてください。',
      toolCalls: toolCallLog,
      iterations
    };
  }
  
  /** ツールを動的に追加する (MCPClientからの登録用) */
  public registerTool(agentTool: AgentTool): void {
    const existing = this.tools.findIndex(tool => tool.name === tool.name);
    if(existing !== -1) {
      this.tools[existing] = agentTool;  // 上書き
    }
    else {
      this.tools.push(agentTool);
    }
    this.log(`🔌 Tool Registered : ${agentTool.name}`);
  }
  
  /** 登録済みツール一覧を返す */
  public getTools(): Array<AgentTool> {
    return [...this.tools];
  }
  
  /** システムプロンプトを差し替える (タスク種別ごとの切り替え用) */
  public setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }
  
  /** Array<AgentTool> を Ollama の Array<Tool> 形式に変換 */
  private buildOllamaTools(): Array<Tool> {
    if(this.tools.length === 0) return [];
    return this.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  }
  
  /** ツールを名前で検索して実行し結果を文字列で返す */
  private async executeTool(toolCall: ToolCall): Promise<string> {
    const name = toolCall.function.name;
    const args = toolCall.function.arguments as Record<string, unknown>;
    const tool = this.tools.find(tool => tool.name === name);
    
    if(tool == null) {
      const message = `Tool Not Found : ${name}`;
      this.log(`❌ ${message}`);
      return message;
    }
    
    try {
      this.log(`  → Executing : ${name}`, args);
      const result = await tool.execute(args);
      this.log(`  ← Result : ${result.slice(0, 200)}${result.length > 200 ? '...' : ''}`);
      return result;
    }
    catch(error) {
      const message = `Tool Execution Failed (${name}) : ${error instanceof Error ? error.message : String(error)}`;
      this.log(`❌ ${message}`);
      return message;
    }
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) console.log(`[AgentCore] ${message}`, ...args);
  }
}
