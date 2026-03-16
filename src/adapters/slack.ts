import { App, LogLevel } from '@slack/bolt';

import { SessionManager } from '../agent/session.js';

import type { Runner } from '../agent/core.js';

export interface SlackAdapterOptions {
  /** Slack Bot Token (`xoxb-...`) */
  botToken?: string;
  /** Slack App Level Token For Socket Mode (`xapp-...`) */
  appToken?: string;
  /** エージェントが処理中であることを示すタイピングインジケータ・デフォルト `true` */
  showTyping?: boolean;
  /** セッションの永続化ディレクトリ・未指定ならメモリのみ */
  persistDir?: string;
  /** 外部から注入する SessionManager (未指定なら内部で生成) */
  sessions?: SessionManager;
  debug?: boolean;
}

export class SlackAdapter {
  private app: App;
  private sessions: SessionManager;
  private core: Runner;
  private showTyping: boolean;
  private debug: boolean;
  
  constructor(core: Runner, options: SlackAdapterOptions = {}) {
    this.core = core;
    
    this.showTyping = options.showTyping ?? true;
    this.debug      = options.debug ?? false;
    
    const botToken  = options.botToken;
    const appToken  = options.appToken;
    if(botToken == null || botToken === '') throw new Error('SLACK_BOT_TOKEN Is Required');
    if(appToken == null || appToken === '') throw new Error('SLACK_APP_TOKEN Is Required (Socket Mode)');
    
    // Socket Mode で起動 : ポート不要・ngrok 不要
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: this.debug ? LogLevel.DEBUG : LogLevel.WARN
    });
    
    this.sessions = options.sessions ?? new SessionManager({
      persistDir: options.persistDir,
      debug: this.debug
    });
    
    this.registerHandlers();
  }
  
  public async start(): Promise<void> {
    await this.app.start();
    console.log('[SlackAdapter] Connected Via Socket Mode ⚡');
  }
  
  public async stop(): Promise<void> {
    await this.app.stop();
    this.sessions.destroy();
    console.log('[SlackAdapter] Stopped');
  }
  
  /** Event Handlers */
  private registerHandlers(): void {
    // DM またはメンション (@bot) に反応する
    this.app.event('app_mention', async ({ event, client, say }) => {
      // メンション部分 (<@UXXXXXXXX>) を除去してメッセージ本文を取り出す
      const text = this.stripMention(event.text);
      if(text === '') return;
      
      // セッション ID : チャンネル ID とユーザ ID の組み合わせ
      // チャンネルごとに独立した会話を保持する
      const sessionId = SessionManager.makeId('slack', event.channel, event.user ?? 'Unknown');
      
      await this.handleMessage({ text, sessionId, channel: event.channel, threadTs: event.thread_ts ?? event.ts, client, say });
    });
    
    this.app.event('message', async ({ event, client, say }) => {
      // サブタイプがある (編集・削除など) や Bot メッセージは無視
      if('subtype' in event && event.subtype != null) return;
      if('bot_id'  in event && event.bot_id  != null) return;
      
      // DM (im) チャンネルのみ反応する (メンション不要)
      // パブリックチャンネルでは `app_mention` のみ対応
      if(event.channel_type == null || event.channel_type !== 'im') return;
      
      const text = 'text' in event ? (event.text ?? '') : '';
      if(text.trim() === '') return;
      
      const userId = 'user' in event ? (event.user ?? 'unknown') : 'unknown';
      const sessionId = SessionManager.makeId('slack', event.channel, userId);
      
      await this.handleMessage({ text, sessionId, channel: event.channel, threadTs: 'ts' in event ? event.ts : undefined, client, say });
    });
    
    // 「会話をリセット」ショートカット or スラッシュコマンド
    this.app.command('/reset', async ({ command, ack }) => {
      await ack();
      const sessionId = SessionManager.makeId('slack', command.channel_id, command.user_id);
      this.sessions.clearHistory(sessionId);
      await this.app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: '🔄 会話履歴をリセットしました。'
      });
    });
  }
  
  /** Core Message Handling */
  private async handleMessage(params: {
    text: string;
    sessionId: string;
    channel: string;
    threadTs?: string;
    client: App['client'];
    say: (args: { text: string; thread_ts?: string }) => Promise<unknown>;
  }): Promise<void> {
    const { text, sessionId, channel, threadTs, say } = params;
    
    this.log(`[${sessionId}] "${text.slice(0, 60)}..."`);
    
    // タイピングインジケータ (処理中であることを示す)
    let typingMessageTs: string | undefined;
    if(this.showTyping) {
      try {
        const res = await say({ text: '⏳ 考え中...', thread_ts: threadTs });
        typingMessageTs = (res as { ts?: string }).ts;
      }
      catch {
        // インジケータ送信失敗は無視
      }
    }
    
    try {
      const result = await this.sessions.chat(sessionId, text, this.core);
      
      // タイピングインジケータを削除して本文を投稿
      if(typingMessageTs != null) await this.app.client.chat.delete({ channel, ts: typingMessageTs }).catch(() => {});
      
      // スレッドに返信
      await say({ text: result.text, thread_ts: threadTs });
      
      // デバッグ時 : tool call サマリーをエフェメラルで表示
      if(this.debug && result.toolCalls.length > 0) {
        const summary = result.toolCalls
          .map(toolCall => `・ \`${toolCall.name}\` → ${toolCall.result.slice(0, 80)}`)
          .join('\n');
        this.log(`Tool Calls :\n${summary}`);
      }
    }
    catch(error) {
      if(typingMessageTs != null) await this.app.client.chat.delete({ channel, ts: typingMessageTs }).catch(() => {});
      await say({ text: '⚠️ エラーが発生しました。しばらくしてからもう一度お試しください。', thread_ts: threadTs });
      this.log('Handle Message Error :', error);
    }
  }
  
  /** `<＠UXXXXXXXX> テキスト` → `テキスト` */
  private stripMention(text: string): string {
    return text.replace(/^<@[A-Z0-9]+>\s*/i, '').trim();
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) console.log(`[SlackAdapter] ${message}`, ...args);
  }
}
