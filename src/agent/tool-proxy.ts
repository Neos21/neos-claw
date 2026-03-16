import { resolve } from 'node:path';

import { confirmPrefix, type AgentCore, type AgentTool, type Runner, type RunResult } from '../agent/core.js';

import type { SessionManager, PendingOperation } from '../agent/session.js';

export interface ToolProxyOptions {
  /** Workspace の絶対パス */
  allowedDir?: string;
  debug?: boolean;
}

/**
 * ToolProxy の責務
 * 
 * 1. ファイル操作ツールが呼ばれる前に「よろしいですか？」確認を挟む (2ターン構造)
 * 2. 新規作成時にファイル存在チェック → あれば拒否
 * 3. 更新・上書き前にバックアップを作成
 * 4. ツール引数の `path` を強制的に `allowedDir` 配下に解決
 *
 * 意図の解釈・ツールの選択はすべてモデルに任せる
 */
export class ToolProxy implements Runner {
  private core: AgentCore;
  private sessions: SessionManager;
  private allowedDir: string;
  private debug: boolean;
  
  // ファイル操作に該当するツール名
  private static readonly fileWriteTools = new Set(['write_file', 'edit_file', 'create_directory', 'move_file']);
  
  constructor(core: AgentCore, sessions: SessionManager, options: ToolProxyOptions = {}) {
    this.core = core;
    this.sessions = sessions;
    
    this.allowedDir = options.allowedDir ?? resolve('./workspace');
    this.log(`Allowed Dir : ${this.allowedDir}`);
    
    this.debug      = options.debug ?? false;
  }
  
  public getTools(): Array<AgentTool> {
    return this.core.getTools().map(tool => this.wrapTool(tool));
  }
  
  /** Runner Interface */
  public async run(history: Array<{ role: string; content: string; }>, userMessage: string, sessionId?: string): Promise<RunResult> {
    // ラップしたツールを一時的に `core` に差し込む
    const original = this.core.getTools();
    for(const tool of original) this.core.registerTool(this.wrapTool(tool, sessionId));
    
    const result = await this.core.run(
      history as Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string; }>,
      userMessage
    );
    
    // 元のツールに戻す
    for(const tool of original) this.core.registerTool(tool);
    
    return result;
  }
  
  /** Tool Wrapping */
  private wrapTool(tool: AgentTool, sessionId?: string): AgentTool {
    const isFileWrite = ToolProxy.fileWriteTools.has(tool.name);
    
    return {
      ...tool,
      execute: async (args: Record<string, unknown>): Promise<string> => {
        // パスを Workspace 配下に解決
        const resolved = this.resolveArgs(args);
        
        if(this.debug) {
          const changed = JSON.stringify(args) !== JSON.stringify(resolved);
          if(changed) this.log(`[${tool.name}] Path Resolved :`, args, '→', resolved);
        }
        
        // ファイル書き込み系ツールは確認・チェック・バックアップを挟む
        if(isFileWrite && sessionId != null) return this.handleFileWrite(tool, resolved, sessionId);
        
        return tool.execute(resolved);
      }
    };
  }
  
  /** File write guard */
  private async handleFileWrite(tool: AgentTool, args: Record<string, unknown>, sessionId: string): Promise<string> {
    const path = typeof args.path === 'string' ? args.path : null;
    if(path == null) return tool.execute(args);
    
    const filename = path.split('/').pop() ?? path;
    
    if(tool.name === 'write_file') {
      // 新規作成チェック
      const fileInfoTool = this.core.getTools().find(tool => tool.name === 'get_file_info');
      if(fileInfoTool != null) {
        const exists = await this.fileExists(fileInfoTool, path);
        
        if(exists) {
          // 既存ファイル → バックアップを取ってから上書き確認
          const backupPath = this.makeBackupPath(path);
          const description =
            `⚠️ \`${filename}\` はすでに存在します。\n` +
            `バックアップ (\`${backupPath.split('/').pop()}\`) を作成してから上書きします。\n` +
            'よろしいですか？(はい / いいえ)';
          
          const pending: PendingOperation = {
            description,
            execute: async () => {
              await this.createBackup(path, backupPath);
              await tool.execute(args);
              return `✅ バックアップを作成し、\`${filename}\` を更新しました。`;
            }
          };
          this.sessions.setPending(sessionId, pending);
          return `${confirmPrefix}${description}`;
        }
        
        // 新規作成 → 確認
        const content = typeof args.content === 'string' ? args.content : '';
        const preview = content === '' ? '(空ファイル)' : `「${content.slice(0, 40)}${content.length > 40 ? '…' : ''}」`;
        const description =
          `📝 \`${filename}\` を新規作成します。\n` +
          `内容 : ${preview}\n` +
          'よろしいですか？(はい / いいえ)';
        
        const pending: PendingOperation = {
          description,
          execute: async () => {
            await tool.execute(args);
            return `✅ \`${filename}\` を作成しました。`;
          }
        };
        this.sessions.setPending(sessionId, pending);
        return `${confirmPrefix}${description}`;
      }
    }
    
    if(tool.name === 'edit_file') {
      // `edit_file` は必ずバックアップを取ってから実行確認
      const backupPath = this.makeBackupPath(path);
      const description =
        `✏️ \`${filename}\` を編集します。\n` +
        `バックアップ (\`${backupPath.split('/').pop()}\`) を作成してから実行します。\n` +
        'よろしいですか？(はい / いいえ)';
      
      const pending: PendingOperation = {
        description,
        execute: async () => {
          await this.createBackup(path, backupPath);
          try {
            const diff = await tool.execute(args);
            return `✅ \`${filename}\` を編集しました。\n\n${diff}`;
          }
          catch(error) {
            // 失敗したらバックアップから復元
            await this.restoreBackup(backupPath, path);
            const message = error instanceof Error ? error.message : String(error);
            return `❌ 編集に失敗しました : ${message}\nバックアップから復元しました。`;
          }
        }
      };
      this.sessions.setPending(sessionId, pending);
      return `${confirmPrefix}${description}`;
    }
    
    // create_directory・move_file → 確認のみ
    const operationName = tool.name === 'create_directory' ? 'ディレクトリを作成' : 'ファイルを移動';
    const description = `📁 ${operationName}します : \`${filename}\`\nよろしいですか？(はい / いいえ)`;
    
    const pending: PendingOperation = {
      description,
      execute: async () => {
        await tool.execute(args);
        return `✅ ${operationName}しました : \`${filename}\``;
      }
    };
    this.sessions.setPending(sessionId, pending);
    return `${confirmPrefix}${description}`;
  }
  
  private makeBackupPath(originalPath: string): string {
    const now = new Date();
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()     ).padStart(2, '0'),
      String(now.getHours()    ).padStart(2, '0'),
      String(now.getMinutes()  ).padStart(2, '0'),
      String(now.getSeconds()  ).padStart(2, '0')
    ].join('');
    return `${originalPath}.BACKUP_${ts}`;
  }
  
  private async restoreBackup(backupPath: string, originalPath: string): Promise<void> {
    const readTool = this.core.getTools().find(tool => tool.name === 'read_text_file') ?? this.core.getTools().find(tool => tool.name === 'read_file');
    const writeTool = this.core.getTools().find(tool => tool.name === 'write_file');
    
    if(readTool == null || writeTool == null) return;
    
    try {
      const content = await readTool.execute({ path: backupPath });
      await writeTool.execute({ path: originalPath, content });
      this.log(`Restored From Backup : ${backupPath} → ${originalPath}`);
    }
    catch(error) {
      this.log('Failed To Restore Backup :', error);
    }
  }
  
  private async createBackup(src: string, dest: string): Promise<void> {
    const readTool = this.core.getTools().find(tool => tool.name === 'read_file') ?? this.core.getTools().find(tool => tool.name === 'read_text_file');
    const writeTool = this.core.getTools().find(tool => tool.name === 'write_file');
    
    if(readTool == null || writeTool == null) {
      this.log('Backup Skipped : read_file Or write_file Not Available');
      return;
    }
    
    const content = await readTool.execute({ path: src });
    await writeTool.execute({ path: dest, content });
    this.log(`Backup Created : ${dest}`);
  }
  
  private async fileExists(fileInfoTool: AgentTool, path: string): Promise<boolean> {
    try {
      await fileInfoTool.execute({ path });
      return true;
    }
    catch {
      return false;
    }
  }
  
  private resolveArgs(args: Record<string, unknown>): Record<string, unknown> {
    // モデルが間違った引数名を使ってきた場合に正規化するマッピング
    // 例 : file_path → path, file_name → path
    const keyAliases: Record<string, string> = {
      'file_path': 'path',
      'file_name': 'path',
      'filename' : 'path',
      'src'      : 'source',
      'dst'      : 'destination'
    };
    const pathKeys = new Set(['path', 'source', 'destination', 'dest', 'target', 'oldPath', 'newPath', 'filepath', 'file']);
    
    const result: Record<string, unknown> = {};
    for(const [key, value] of Object.entries(args)) {
      // エイリアスがあれば正規のキー名に変換
      const normalizedKey = keyAliases[key] ?? key;
      if(pathKeys.has(normalizedKey) && typeof value === 'string' && value !== '') {
        result[normalizedKey] = this.resolvePath(value);
      }
      else {
        result[normalizedKey] = value;
      }
    }
    return result;
  }
  
  private resolvePath(raw: string): string {
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    
    if(normalized.startsWith(this.allowedDir + '/') || normalized === this.allowedDir) return normalized;
    
    const withoutPrefix = normalized
      .replace(/^\.?\//, '')
      .replace(/^workspace\//i, '')
      .replace(/^\.?\/workspace\//i, '');
    
    const isAbsolute = withoutPrefix.startsWith('/') || normalized.startsWith('/');
    if(isAbsolute) {
      const basename =
        withoutPrefix.split('/').filter(value => value !== '').pop() ??
        normalized.split('/').filter(value => value !== '').pop() ??
        'file';
      return `${this.allowedDir}/${basename}`;
    }
    
    return `${this.allowedDir}/${withoutPrefix}`;
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) console.log(`[ToolProxy] ${message}`, ...args);
  }
}
