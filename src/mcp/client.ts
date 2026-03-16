import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';

import type { AgentCore, AgentTool } from '../agent/core.js';

/** `mcp-config.json` の1サーバ分の設定 */
export interface McpServerConfig {
  command: string;
  args?: Array<string>;
  /** サーバに渡す追加環境変数・値に `${ENV_VAR}` 形式を使うと `process.env` から展開される */
  env?: Record<string, string>;
  /** AgentCore に登録しないツール名のリスト */
  exclude?: Array<string>;
}

/** `mcp-config.json` のトップレベル構造 */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** 起動済み MCP サーバの管理レコード */
interface ManagedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  /** このサーバが提供するツール名一覧 */
  toolNames: Array<string>;
}

export class McpClient {
  private servers = new Map<string, ManagedServer>();
  private debug: boolean;
  
  constructor(options: { debug?: boolean } = {}) {
    this.debug = options.debug ?? false;
  }
  
  /**
   * `mcp-config.json` を読み込み全 MCP サーバを起動して AgentCore にツールを登録する
   * 
   * @param configPath `mcp-config.json` のパス
   * @param core ツールを登録する AgentCore インスタンス
   */
  public async loadConfig(configPath: string, core: AgentCore): Promise<void> {
    const config = this.readConfig(configPath);
    const entries = Object.entries(config.mcpServers);
    
    this.log(`Loading ${entries.length} MCP Server(s) From ${configPath}`);
    
    // 全サーバを並列で起動
    await Promise.all(
      entries.map(([name, serverConfig]) =>
        this.startServer(name, serverConfig, core).catch(error => {
          // 1サーバの失敗で全体を止めない
          console.error(`[McpClient] Failed To Start Server "${name}" :`, error);
        })
      )
    );
    
    const total = [...this.servers.values()].reduce((number, server) => number + server.toolNames.length, 0);
    this.log(`✅ Ready. ${this.servers.size} Server(s), ${total} Tool(s) Registered`);
  }
  
  /** 全 MCP サーバを停止する (プロセス終了時に呼ぶ) */
  public async shutdown(): Promise<void> {
    this.log('Shutting Down All MCP Servers...');
    
    const closeWithTimeout = (managedServer: ManagedServer): Promise<void> => {
      const timeout = new Promise<void>(resolve => setTimeout(resolve, 3000));
      const close = managedServer.transport.close().catch(error => {
        this.log(`Error Closing Transport For "${managedServer.name}" :`, error);
      });
      return Promise.race([close, timeout]).then(() => {
        const proc = (managedServer.transport as unknown as { _process?: { killed: boolean; kill: () => void } })._process;
        if(proc != null && !proc.killed) {
          this.log(`Force Killing "${managedServer.name}"...`);
          proc.kill();
        }
      });
    };
    
    await Promise.all([...this.servers.values()].map(closeWithTimeout));
    this.servers.clear();
    this.log('All MCP Servers Stopped');
  }
  
  /** 起動済みサーバの一覧を返す */
  public getServerNames(): Array<string> {
    return [...this.servers.keys()];
  }
  
  /** 登録済みツール名の一覧を返す (デバッグログ用) */
  public getToolNames(): Array<string> {
    return [...this.servers.values()].flatMap(server => server.toolNames);
  }
  
  /** 1サーバを起動しツールを発見して AgentCore に登録する */
  private async startServer(name: string, config: McpServerConfig, core: AgentCore): Promise<void> {
    this.log(`Starting Server : "${name}" (${config.command} ${(config.args ?? []).join(' ')})`);
    
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: this.resolveEnv(config.env)
    });
    
    const client = new Client({ name: `neos-claw-${name}`, version: '0.0.0' });
    
    await client.connect(transport);
    this.log(`  Connected : "${name}"`);
    
    // ツール一覧を取得
    const { tools } = await client.listTools();
    this.log(`  Tools From "${name}" : ${tools.map(tool => tool.name).join(', ')}`);
    
    const toolNames: Array<string> = [];
    
    const excludeSet = new Set(config.exclude ?? []);
    
    for(const tool of tools) {
      if(excludeSet.has(tool.name)) {
        this.log(`  Excluded : "${tool.name}"`);
        continue;
      }
      const agentTool: AgentTool = {
        name: tool.name,
        description: tool.description ?? '',
        parameters: (tool.inputSchema as AgentTool['parameters']) ?? {
          type: 'object',
          properties: {}
        },
        // クロージャで `client` と `tool.name` をキャプチャ
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
  
  /** MCP Call Tool のレスポンス (`content` 配列) を AgentCore が扱いやすい単一文字列に変換する */
  private normalizeToolResult(content: Array<{ type: string; text?: string; [key: string]: unknown; }>): string {
    return content
      .map(block => {
        if(block.type === 'text') return block.text ?? '';
        // `image` や `resource` など他の型は JSON 文字列として返す
        return JSON.stringify(block);
      })
      .join('\n')
      .trim();
  }
  
  /** `mcp-config.json` を読み込んでパースする */
  private readConfig(configPath: string): McpConfig {
    try {
      const raw = readFileSync(configPath, 'utf-8');
      return JSON.parse(raw) as McpConfig;
    }
    catch(error) {
      throw new Error(`Failed To Read MCP Config At "${configPath}" : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /** `env` の値に含まれる `${VAR_NAME}` 形式のプレースホルダーを `process.env` から展開する */
  private resolveEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
    if(env == null) return undefined;
    return Object.fromEntries(
      Object.entries(env).map(([key, value]) => [
        key,
        value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '')
      ])
    );
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) console.log(`[McpClient] ${message}`, ...args);
  }
}
