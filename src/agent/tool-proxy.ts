import { resolve } from 'node:path';

import type { AgentCore, AgentTool, Runner, RunResult } from './core.js';

// ----------------------------------------------------------------
// ToolProxy
// ----------------------------------------------------------------

/**
 * ToolProxy の責務はただひとつ：
 * モデルが tool call に渡してきた「path」引数を、
 * 強制的に allowedDir（workspace）配下に解決すること。
 *
 * 意図の解釈・ツールの選択はすべてモデルに任せる。
 * プロキシは「パスの番人」に徹する。
 */
export class ToolProxy implements Runner {
  private core: AgentCore;
  private allowedDir: string;
  private debug: boolean;
  
  constructor(core: AgentCore, options: { debug?: boolean } = {}) {
    this.core = core;
    this.debug = options.debug ?? false;
    
    // allowedDir の優先順:
    //   1. 環境変数 MCP_WORKSPACE
    //   2. デフォルト: カレントディレクトリの ./workspace
    const envWorkspace = process.env.MCP_WORKSPACE;
    this.allowedDir = (envWorkspace != null && envWorkspace !== '')
      ? envWorkspace
      : resolve('./workspace');
    
    this.log(`Allowed dir: ${this.allowedDir}`);
  }
  
  // ----------------------------------------------------------------
  // Runner interface
  // ----------------------------------------------------------------
  
  getTools(): Array<AgentTool> {
    // 全ツールの execute をパスインターセプト版にラップして返す
    return this.core.getTools().map(tool => this.wrapTool(tool));
  }
  
  async run(
    history: Array<{ role: string; content: string }>,
    userMessage: string
  ): Promise<RunResult> {
    // ツールをラップした状態で core.run() を呼ぶために
    // core のツール一覧を一時的にラップ版に差し替える
    const original = this.core.getTools();
    for(const tool of original) {
      this.core.registerTool(this.wrapTool(tool));
    }
    
    const result = await this.core.run(
      history as Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }>,
      userMessage
    );
    
    // 実行後に元のツール（ラップなし）に戻す
    for(const tool of original) {
      this.core.registerTool(tool);
    }
    
    return result;
  }
  
  // ----------------------------------------------------------------
  // Path interception
  // ----------------------------------------------------------------
  
  /**
   * ツールの execute をラップし、引数中のパス文字列を
   * すべて allowedDir 配下に解決してから元の execute を呼ぶ。
   */
  private wrapTool(tool: AgentTool): AgentTool {
    return {
      ...tool,
      execute: async (args: Record<string, unknown>): Promise<string> => {
        const resolved = this.resolveArgs(args);
        if(this.debug) {
          const changed = JSON.stringify(args) !== JSON.stringify(resolved);
          if(changed) {
            this.log(`[${tool.name}] path resolved:`, args, '→', resolved);
          }
        }
        return tool.execute(resolved);
      }
    };
  }
  
  /**
   * args オブジェクトを走査して、パスっぽい文字列を
   * すべて allowedDir 配下に解決する。
   *
   * 対象キー: path / source / destination / dest / target / oldPath / newPath
   */
  private resolveArgs(args: Record<string, unknown>): Record<string, unknown> {
    const PATH_KEYS = new Set([
      'path', 'source', 'destination', 'dest',
      'target', 'oldPath', 'newPath', 'filepath', 'file'
    ]);
    
    const result: Record<string, unknown> = {};
    for(const [key, value] of Object.entries(args)) {
      if(PATH_KEYS.has(key) && typeof value === 'string' && value !== '') {
        result[key] = this.resolvePath(value);
      }
      else {
        result[key] = value;
      }
    }
    return result;
  }
  
  /**
   * パス文字列を allowedDir 配下に強制解決する。
   *
   * ルール（優先順）:
   * 1. すでに allowedDir 配下 → そのまま
   * 2. "workspace/foo.txt" などのプレフィックス付き → allowedDir/foo.txt
   * 3. 絶対パスだが allowedDir 配下でない → ファイル名だけ取り出して allowedDir に結合
   * 4. 相対パス / ファイル名のみ → allowedDir に結合
   */
  private resolvePath(raw: string): string {
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    
    // 1. すでに allowedDir 配下
    if(
      normalized.startsWith(this.allowedDir + '/') ||
      normalized === this.allowedDir
    ) {
      return normalized;
    }
    
    // 2. "workspace/..." や "./workspace/..." などのプレフィックスを除去
    const withoutPrefix = normalized
      .replace(/^\.?\//, '')
      .replace(/^workspace\//i, '')
      .replace(/^\.?\/workspace\//i, '');
    
    // 3. 絶対パスだが allowedDir 配下でない → ファイル名だけ取り出す
    const isAbsolute = withoutPrefix.startsWith('/') || normalized.startsWith('/');
    if(isAbsolute) {
      const basename =
        withoutPrefix.split('/').filter(s => s !== '').pop() ??
        normalized.split('/').filter(s => s !== '').pop() ??
        'file';
      return `${this.allowedDir}/${basename}`;
    }
    
    // 4. 相対パス / ファイル名のみ
    return `${this.allowedDir}/${withoutPrefix}`;
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) {
      console.log(`[ToolProxy] ${message}`, ...args);
    }
  }
}