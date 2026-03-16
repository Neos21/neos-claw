import { readdirSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Runner, RunResult } from './core.js';
import type { Message } from 'ollama';

/** セッション ID のチャネルプレフィックス */
export type ChannelPrefix = 'slack' | 'discord' | 'web';

/**
 * セッション ID 形式
 * - slack:C012AB3CD:U012AB3CD
 * - discord:123456789012345678
 * - web:550e8400-e29b-41d4-a716-446655440000
 */
export type SessionId = string;

export interface Session {
  id: SessionId;
  /** チャネル種別 */
  channel: ChannelPrefix;
  /** 会話履歴 (System メッセージは含まない・`core.ts` が付与する) */
  histories: Array<Message>;
  /** 最終アクティブ日時 */
  lastActiveAt: Date;
  /** セッション作成日時 */
  createdAt: Date;
}

export interface SessionManagerOptions {
  /** 会話履歴をファイルに永続化するディレクトリ・未指定ならメモリのみ (プロセス再起動で消える) */
  persistDir?: string;
  /** 1 セッションが保持するメッセージの最大数 (古いものから削除)・デフォルト 50 */
  maxHistoryLength?: number;
  /** アイドル状態のセッションを自動削除するまでの時間 (ms)・デフォルト: 2時間 */
  sessionTtlMs?: number;
  /** デバッグログを出力するか否か */
  debug?: boolean;
}

export class SessionManager {
  private sessions = new Map<SessionId, Session>();
  private persistDir: string | null;
  private maxHistoryLength: number;
  private sessionTtlMs: number;
  private debug: boolean;
  private gcTimer: NodeJS.Timeout | null = null;
  
  constructor(options: SessionManagerOptions = {}) {
    this.persistDir = options.persistDir ?? null;
    this.maxHistoryLength = options.maxHistoryLength ?? 50;
    this.sessionTtlMs = options.sessionTtlMs ?? 2 * 60 * 60 * 1000; // 2時間
    this.debug = options.debug ?? false;
    
    if(this.persistDir != null) {
      mkdirSync(this.persistDir, { recursive: true });
      this.loadAllFromDisk();
    }
    
    // 期限切れセッションを定期的に GC する (10分ごと)
    this.gcTimer = setInterval(() => this.gc(), 10 * 60 * 1000);
    // Node.js プロセス終了を妨げないようにする
    this.gcTimer.unref();
  }
  
  /**
   * セッション ID を生成するファクトリ関数
   * 
   * @example
   * SessionManager.makeId('slack', 'C012AB3CD', 'U012AB3CD')
   * // → 'slack:C012AB3CD:U012AB3CD'
   *
   * SessionManager.makeId('discord', '123456789')
   * // → 'discord:123456789'
   *
   * SessionManager.makeId('web', crypto.randomUUID())
   * // → 'web:550e8400-...'
   */
  public static makeId(channel: ChannelPrefix, ...parts: Array<string>): SessionId {
    return [channel, ...parts].join(':');
  }
  
  /**
   * AgentCore にメッセージを送り応答を返す
   * セッションの取得・作成・履歴の追加・永続化を全て処理する
   * 
   * @param sessionId セッションID (`makeId()` で生成)
   * @param userMessage ユーザのメッセージ
   * @param core AgentCore インスタンス
   */
  public async chat(
    sessionId: SessionId,
    userMessage: string,
    core: Runner
  ): Promise<RunResult> {
    const session = this.getOrCreate(sessionId);
    
    this.log(`[${sessionId}] User : ${userMessage.slice(0, 80)}...`);
    
    // `core.run()` に渡すのは既存の履歴のみ (System は `core` が付与)
    const result = await core.run(session.histories, userMessage);
    
    // 履歴に今回のやり取りを追加する
    session.histories.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: result.text }
    );
    
    // Tool Call の中間メッセージも履歴に保持する場合はここで追加可能
    // (現状はユーザ・アシスタントのターンのみ保持してシンプルに保つ)
    
    // 最大長を超えたら古いメッセージから削除 (先頭から2件ずつ削除)
    while(session.histories.length > this.maxHistoryLength) session.histories.splice(0, 2);
    
    session.lastActiveAt = new Date();
    
    if(this.persistDir != null) this.saveToDisk(session);
    
    this.log(`[${sessionId}] Assistant : ${result.text.slice(0, 80)}...`);
    return result;
  }
  
  /** セッションの会話履歴をリセットする */
  public clearHistory(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId);
    if(session != null) {
      session.histories = [];
      session.lastActiveAt = new Date();
      if(this.persistDir != null) this.saveToDisk(session);
      this.log(`[${sessionId}] History Cleared`);
    }
  }
  
  /** セッションを削除する */
  public deleteSession(sessionId: SessionId): void {
    this.sessions.delete(sessionId);
    if(this.persistDir != null) this.deleteFromDisk(sessionId);
    this.log(`[${sessionId}] Session Deleted`);
  }
  
  /** 現在アクティブなセッション数を返す */
  public get size(): number {
    return this.sessions.size;
  }
  
  /** GC タイマーを停止する (テスト・シャットダウン時用) */
  public destroy(): void {
    if(this.gcTimer == null) return;
    
    clearInterval(this.gcTimer);
    this.gcTimer = null;
  }
  
  private getOrCreate(sessionId: SessionId): Session {
    if(this.sessions.has(sessionId)) return this.sessions.get(sessionId)!;
    
    const channel = sessionId.split(':')[0] as ChannelPrefix;
    const session: Session = {
      id: sessionId,
      channel,
      histories: [],
      lastActiveAt: new Date(),
      createdAt: new Date()
    };
    
    this.sessions.set(sessionId, session);
    this.log(`[${sessionId}] Session Created`);
    return session;
  }
  
  /** 期限切れセッションをメモリから削除する */
  private gc(): void {
    const now = Date.now();
    let removed = 0;
    for(const [id, session] of this.sessions) {
      if(now - session.lastActiveAt.getTime() > this.sessionTtlMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if(removed > 0) this.log(`GC : Removed ${removed} Expired Session(s). Active : ${this.sessions.size}`);
  }
  
  /** 永続化 (オプション) */
  private sessionPath(sessionId: SessionId): string {
    // ファイル名に使えない文字（:）をアンダースコアに変換する
    const safe = sessionId.replace(/:/g, '_');
    return join(this.persistDir!, `${safe}.json`);
  }
  
  private saveToDisk(session: Session): void {
    try {
      const data = JSON.stringify(
        {
          ...session,
          lastActiveAt: session.lastActiveAt.toISOString(),
          createdAt: session.createdAt.toISOString()
        },
        null,
        2
      );
      writeFileSync(this.sessionPath(session.id), data, 'utf-8');
    }
    catch(error) {
      this.log(`Failed To Save Session ${session.id} :`, error);
    }
  }
  
  private loadAllFromDisk(): void {
    let files: Array<string>;
    try {
      files = readdirSync(this.persistDir!).filter((file: string) => file.endsWith('.json'));
    }
    catch {
      return;
    }
    
    for(const file of files) {
      try {
        const raw = readFileSync(join(this.persistDir!, file), 'utf-8');
        const data = JSON.parse(raw) as Session & {
          lastActiveAt: string;
          createdAt: string;
        };
        const session: Session = {
          ...data,
          lastActiveAt: new Date(data.lastActiveAt),
          createdAt: new Date(data.createdAt)
        };
        this.sessions.set(session.id, session);
      }
      catch(error) {
        this.log(`Failed To Load Session File ${file} :`, error);
      }
    }
    this.log(`Loaded ${this.sessions.size} Session(s) From Disk`);
  }
  
  private deleteFromDisk(sessionId: SessionId): void {
    try {
      const path = this.sessionPath(sessionId);
      if(existsSync(path)) unlinkSync(path);
    }
    catch(error) {
      this.log(`Failed To Delete Session File For ${sessionId} :`, error);
    }
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) console.log(`[SessionManager] ${message}`, ...args);
  }
}
