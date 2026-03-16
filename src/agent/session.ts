import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Runner, RunResult } from './core.js';
import type { Message } from 'ollama';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

/** セッションIDのチャネルプレフィックス */
export type ChannelPrefix = 'slack' | 'discord' | 'web';

/**
 * セッションID形式:
 *   slack:C012AB3CD:U012AB3CD
 *   discord:123456789012345678
 *   web:550e8400-e29b-41d4-a716-446655440000
 */
export type SessionId = string;

/**
 * 確認待ちの保留操作。
 * ToolProxy が「よろしいですか？」を返した後、
 * 次のターンで「はい」が来たら実行する。
 */
export interface PendingOperation {
  /** 実行する関数（はい時に呼ぶ） */
  execute: () => Promise<string>;
  /** 確認メッセージ（ユーザーに見せた内容） */
  description: string;
}

export interface Session {
  id: SessionId;
  /** チャネル種別 */
  channel: ChannelPrefix;
  /** 会話履歴（system メッセージは含まない。core.ts が付与する） */
  history: Array<Message>;
  /** 確認待ちの保留操作 */
  pending: PendingOperation | null;
  /** 最終アクティブ日時 */
  lastActiveAt: Date;
  /** セッション作成日時 */
  createdAt: Date;
}

export interface SessionManagerOptions {
  /**
   * 会話履歴をファイルに永続化するディレクトリ。
   * 未指定ならメモリのみ（プロセス再起動で消える）。
   */
  persistDir?: string;
  /**
   * 1セッションが保持するメッセージの最大数（古いものから削除）。
   * デフォルト: 50
   */
  maxHistoryLength?: number;
  /**
   * アイドル状態のセッションを自動削除するまでの時間（ms）。
   * デフォルト: 2時間
   */
  sessionTtlMs?: number;
  /** デバッグログを出力するか */
  debug?: boolean;
}

// ----------------------------------------------------------------
// SessionManager
// ----------------------------------------------------------------

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
    
    if(this.persistDir) {
      mkdirSync(this.persistDir, { recursive: true });
      this.loadAllFromDisk();
    }
    
    // 期限切れセッションを定期的にGCする（10分ごと）
    this.gcTimer = setInterval(() => this.gc(), 10 * 60 * 1000);
    // Node.js プロセス終了を妨げないようにする
    this.gcTimer.unref();
  }
  
  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------
  
  /**
   * セッションIDを生成するファクトリ関数
   * 
   * @example
   * SessionManager.makeId("slack", "C012AB3CD", "U012AB3CD")
   * // → "slack:C012AB3CD:U012AB3CD"
   *
   * SessionManager.makeId("discord", "123456789")
   * // → "discord:123456789"
   *
   * SessionManager.makeId("web", crypto.randomUUID())
   * // → "web:550e8400-..."
   */
  static makeId(channel: ChannelPrefix, ...parts: Array<string>): SessionId {
    return [channel, ...parts].join(':');
  }
  
  /**
   * AgentCore にメッセージを送り、応答を返す。
   * セッションの取得・作成・履歴の追加・永続化をすべて処理する。
   * 
   * @param sessionId - セッションID（makeId() で生成）
   * @param userMessage - ユーザーのメッセージ
   * @param core - AgentCore インスタンス
   */
  async chat(
    sessionId: SessionId,
    userMessage: string,
    core: Runner
  ): Promise<RunResult> {
    const session = this.getOrCreate(sessionId);
    
    this.log(`[${sessionId}] User: ${userMessage.slice(0, 80)}...`);
    
    // ── 保留操作の処理 ──────────────────────────────────────────
    if(session.pending != null) {
      const pending = session.pending;
      session.pending = null;
      
      const isYes = /^(はい|yes|y|ok|おk|うん|いいよ|どうぞ|実行|お願い)$/i.test(userMessage.trim());
      const isNo  = /^(いいえ|no|n|やめ|キャンセル|中止|止め|やっぱり)/.test(userMessage.trim());
      
      if(isYes) {
        const toolResult = await pending.execute();
        const result: RunResult = {
          text: toolResult,
          toolCalls: [],
          iterations: 1
        };
        session.history.push(
          { role: 'user', content: userMessage },
          { role: 'assistant', content: result.text }
        );
        session.lastActiveAt = new Date();
        if(this.persistDir != null) this.saveToDisk(session);
        return result;
      }
      
      if(isNo) {
        const result: RunResult = {
          text: '操作をキャンセルしました。',
          toolCalls: [],
          iterations: 0
        };
        session.history.push(
          { role: 'user', content: userMessage },
          { role: 'assistant', content: result.text }
        );
        session.lastActiveAt = new Date();
        if(this.persistDir != null) this.saveToDisk(session);
        return result;
      }
      
      // はい/いいえ以外の返答 → 保留を破棄して通常処理に流す
      this.log(`[${sessionId}] Pending operation discarded (unclear response)`);
    }
    
    // core.run() に渡すのは既存の履歴のみ（system は core が付与）
    const result = await core.run(session.history, userMessage, sessionId);
    
    // 履歴に今回のやり取りを追加
    session.history.push(
      { role: 'user', content: userMessage },
      { role: 'assistant', content: result.text }
    );
    
    // tool call の中間メッセージも履歴に保持する場合はここで追加可能
    // （現状はユーザー/アシスタントのターンのみ保持してシンプルに保つ）
    
    // 最大長を超えたら古いメッセージから削除（先頭から2件ずつ削除）
    while(session.history.length > this.maxHistoryLength) {
      session.history.splice(0, 2);
    }
    
    session.lastActiveAt = new Date();
    
    if(this.persistDir) {
      this.saveToDisk(session);
    }
    
    this.log(`[${sessionId}] Assistant: ${result.text.slice(0, 80)}...`);
    
    return result;
  }
  
  /**
   * 確認待ち操作をセッションに登録する（ToolProxy から呼ぶ）
   */
  setPending(sessionId: SessionId, pending: PendingOperation): void {
    const session = this.getOrCreate(sessionId);
    session.pending = pending;
    this.log(`[${sessionId}] Pending operation set: ${pending.description}`);
  }
  
  /**
   * セッションの会話履歴をリセットする
   */
  clearHistory(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId);
    if(session) {
      session.history = [];
      session.lastActiveAt = new Date();
      if(this.persistDir) this.saveToDisk(session);
      this.log(`[${sessionId}] History cleared.`);
    }
  }
  
  /**
   * セッションを削除する
   */
  deleteSession(sessionId: SessionId): void {
    this.sessions.delete(sessionId);
    if(this.persistDir) {
      this.deleteFromDisk(sessionId);
    }
    this.log(`[${sessionId}] Session deleted.`);
  }
  
  /**
   * 現在アクティブなセッション数を返す
   */
  get size(): number {
    return this.sessions.size;
  }
  
  /**
   * GCタイマーを停止する（テスト・シャットダウン時用）
   */
  destroy(): void {
    if(this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }
  
  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------
  
  private getOrCreate(sessionId: SessionId): Session {
    if(this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }
    
    const channel = sessionId.split(':')[0] as ChannelPrefix;
    const session: Session = {
      id: sessionId,
      channel,
      history: [],
      pending: null,
      lastActiveAt: new Date(),
      createdAt: new Date()
    };
    
    this.sessions.set(sessionId, session);
    this.log(`[${sessionId}] Session created.`);
    return session;
  }
  
  /** 期限切れセッションをメモリから削除 */
  private gc(): void {
    const now = Date.now();
    let removed = 0;
    for(const [id, session] of this.sessions) {
      if(now - session.lastActiveAt.getTime() > this.sessionTtlMs) {
        this.sessions.delete(id);
        removed++;
      }
    }
    if(removed > 0) {
      this.log(`GC: removed ${removed} expired session(s). Active: ${this.sessions.size}`);
    }
  }
  
  // ----------------------------------------------------------------
  // 永続化（オプション）
  // ----------------------------------------------------------------
  
  private sessionPath(sessionId: SessionId): string {
    // プレフィックス（web / slack / discord）でサブディレクトリに振り分ける
    const channel = sessionId.split(':')[0] ?? 'web';
    const safe = sessionId.replace(/:/g, '_');
    const dir = join(this.persistDir!, channel);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${safe}.json`);
  }
  
  private saveToDisk(session: Session): void {
    try {
      // pending は関数を含むためシリアライズ不可 → 保存しない（再起動時に破棄）
      const { pending: _pending, ...rest } = session;
      const data = JSON.stringify(
        {
          ...rest,
          lastActiveAt: session.lastActiveAt.toISOString(),
          createdAt: session.createdAt.toISOString()
        },
        null,
        2
      );
      writeFileSync(this.sessionPath(session.id), data, 'utf-8');
    }
    catch(err) {
      this.log(`Failed to save session ${session.id}:`, err);
    }
  }
  
  private loadAllFromDisk(): void {
    // web / slack / discord サブディレクトリを再帰的に読み込む
    const channels: Array<ChannelPrefix> = ['web', 'slack', 'discord'];
    const filePairs: Array<{ dir: string; file: string }> = [];
    
    for(const channel of channels) {
      const dir = join(this.persistDir!, channel);
      try {
        const files = readdirSync(dir).filter(f => f.endsWith('.json'));
        for(const file of files) filePairs.push({ dir, file });
      }
      catch {
        // サブディレクトリが存在しない場合はスキップ
      }
    }
    
    for(const { dir, file } of filePairs) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const data = JSON.parse(raw) as Session & {
          lastActiveAt: string;
          createdAt: string;
        };
        const session: Session = {
          ...data,
          pending: null,  // 関数は保存できないので再起動時は常に null
          lastActiveAt: new Date(data.lastActiveAt),
          createdAt: new Date(data.createdAt)
        };
        this.sessions.set(session.id, session);
      }
      catch(err) {
        this.log(`Failed to load session file ${file}:`, err);
      }
    }
    this.log(`Loaded ${this.sessions.size} session(s) from disk.`);
  }
  
  private deleteFromDisk(sessionId: SessionId): void {
    try {
      const path = this.sessionPath(sessionId);
      if(existsSync(path)) unlinkSync(path);
    }
    catch(err) {
      this.log(`Failed to delete session file for ${sessionId}:`, err);
    }
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) {
      console.log(`[SessionManager] ${message}`, ...args);
    }
  }
}