import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';

import type { AgentCore, AgentTool } from '../core.js';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

/** mcp-config.json の1サーバー分の設定 */
export interface McpServerConfig {
  command: string;
  args?: Array<string>;
  /** サーバーに渡す追加環境変数。値に "${ENV_VAR}" 形式を使うと process.env から展開される */
  env?: Record<string, string>;
  /** AgentCore に登録しないツール名のリスト */
  exclude?: Array<string>;
}

/** mcp-config.json のトップレベル構造 */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** 起動済みMCPサーバーの管理レコード */
interface ManagedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  /** このサーバーが提供するツール名一覧 */
  toolNames: Array<string>;
}

// ----------------------------------------------------------------
// McpClient
// ----------------------------------------------------------------

export class McpClient {
  private servers = new Map<string, ManagedServer>();
  private debug: boolean;
  
  constructor(options: { debug?: boolean } = {}) {
    this.debug = options.debug ?? false;
  }
  
  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------
  
  /**
   * mcp-config.json を読み込み、全MCPサーバーを起動して
   * AgentCore にツールを登録する。
   * 
   * @param configPath - mcp-config.json のパス
   * @param core       - ツールを登録する AgentCore インスタンス
   */
  async loadConfig(configPath: string, core: AgentCore): Promise<void> {
    const config = this.readConfig(configPath);
    const entries = Object.entries(config.mcpServers);
    
    this.log(`Loading ${entries.length} MCP server(s) from ${configPath}`);
    
    // 全サーバーを並列で起動
    await Promise.all(
      entries.map(([name, serverConfig]) =>
        this.startServer(name, serverConfig, core).catch(err => {
          // 1サーバーの失敗で全体を止めない
          console.error(`[McpClient] Failed to start server "${name}":`, err);
        })
      )
    );
    
    const total = [...this.servers.values()].reduce((n, s) => n + s.toolNames.length, 0);
    this.log(`✅ Ready. ${this.servers.size} server(s), ${total} tool(s) registered.`);
  }
  
  /**
   * 全MCPサーバーを停止する（プロセス終了時に呼ぶ）
   */
  async shutdown(): Promise<void> {
    this.log('Shutting down all MCP servers...');
    
    const closeWithTimeout = (s: ManagedServer): Promise<void> => {
      const timeout = new Promise<void>(resolve => setTimeout(resolve, 3000));
      const close = s.transport.close().catch(err => {
        this.log(`Error closing transport for "${s.name}":`, err);
      });
      return Promise.race([close, timeout]).then(() => {
        const proc = (s.transport as unknown as { _process?: { killed: boolean; kill: () => void } })._process;
        if(proc && !proc.killed) {
          this.log(`Force killing "${s.name}"...`);
          proc.kill();
        }
      });
    };
    
    await Promise.all([...this.servers.values()].map(closeWithTimeout));
    this.servers.clear();
    this.log('All MCP servers stopped.');
  }
  
  /**
   * 起動済みサーバーの一覧を返す
   */
  getServerNames(): Array<string> {
    return [...this.servers.keys()];
  }
  
  /**
   * 登録済みツール名の一覧を返す（デバッグ・ログ用）
   */
  getToolNames(): Array<string> {
    return [...this.servers.values()].flatMap(s => s.toolNames);
  }
  
  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------
  
  /** 1サーバーを起動し、ツールを発見して AgentCore に登録する */
  private async startServer(
    name: string,
    config: McpServerConfig,
    core: AgentCore
  ): Promise<void> {
    this.log(`Starting server: "${name}" (${config.command} ${(config.args ?? []).join(' ')})`);
    
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: this.resolveEnv(config.env)
    });
    
    const client = new Client({ name: `lightagent-${name}`, version: '1.0.0' });
    
    await client.connect(transport);
    this.log(`  Connected: "${name}"`);
    
    // ツール一覧を取得
    const { tools } = await client.listTools();
    this.log(`  Tools from "${name}": ${tools.map(t => t.name).join(', ')}`);
    
    const toolNames: Array<string> = [];
    
    const excludeSet = new Set(config.exclude ?? []);
    
    for(const tool of tools) {
      if(excludeSet.has(tool.name)) {
        this.log(`  Excluded: "${tool.name}"`);
        continue;
      }
      const agentTool: AgentTool = {
        name: tool.name,
        description: tool.description ?? '',
        parameters: (tool.inputSchema as AgentTool['parameters']) ?? {
          type: 'object',
          properties: {}
        },
        // クロージャで client と tool.name をキャプチャ
        execute: async args => {
          const result = await client.callTool({ name: tool.name, arguments: args });
          
          // MCP のレスポンスを文字列に正規化する
          type ContentBlock = { type: string; text?: string; [key: string]: unknown };
          return this.normalizeToolResult(result.content as Array<ContentBlock>);
        }
      };
      
      core.registerTool(agentTool);
      toolNames.push(tool.name);
    }
    
    this.servers.set(name, { name, client, transport, toolNames });
  }
  
  /**
   * MCP callTool のレスポンス（content 配列）を
   * AgentCore が扱いやすい単一文字列に変換する
   */
  private normalizeToolResult(
    content: Array<{ type: string; text?: string; [key: string]: unknown }>
  ): string {
    return content
      .map(block => {
        if(block.type === 'text') return block.text ?? '';
        // image や resource など他の型は JSON 文字列として返す
        return JSON.stringify(block);
      })
      .join('\n')
      .trim();
  }
  
  /** mcp-config.json を読み込んでパースする */
  private readConfig(configPath: string): McpConfig {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      return JSON.parse(raw) as McpConfig;
    }
    catch(err) {
      throw new Error(
        `Failed to read MCP config at "${configPath}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  
  /**
   * env の値に含まれる "${VAR_NAME}" 形式のプレースホルダーを
   * process.env から展開する。
   */
  private resolveEnv(
    env: Record<string, string> | undefined
  ): Record<string, string> | undefined {
    if(!env) return undefined;
    return Object.fromEntries(
      Object.entries(env).map(([k, v]) => [
        k,
        v.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '')
      ])
    );
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) {
      console.log(`[McpClient] ${message}`, ...args);
    }
  }
}