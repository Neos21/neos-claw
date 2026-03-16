import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  ActivityType,
  type Message,
  type TextChannel,
  type DMChannel,
  type ThreadChannel
} from 'discord.js';

import { SessionManager } from '../agent/session.js';

import type { Runner } from '../agent/core.js';

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export interface DiscordAdapterOptions {
  /** Discord Bot Token */
  token?: string;
  /**
   * エージェントが処理中であることを示すタイピングインジケーター。
   * デフォルト: true
   */
  showTyping?: boolean;
  /**
   * 
   * - "mention" : メンション（@bot）のみ反応（デフォルト）
   * - "all"     : 全メッセージに反応（プライベートチャンネル・専用チャンネル向け）
   */
  channelMode?: 'mention' | 'all';
  /**
   * "all" モード時に反応するチャンネルIDの許可リスト。
   * 未指定なら全チャンネルで反応する。
   */
  allowedChannelIds?: Array<string>;
  /** セッションの永続化ディレクトリ */
  persistDir?: string;
  /** 外部から注入する SessionManager（未指定なら内部で生成） */
  sessions?: SessionManager;
  debug?: boolean;
}

// ----------------------------------------------------------------
// DiscordAdapter
// ----------------------------------------------------------------

export class DiscordAdapter {
  private client: Client;
  private sessions: SessionManager;
  private core: Runner;
  private showTyping: boolean;
  private channelMode: 'mention' | 'all';
  private allowedChannelIds: Set<string>;
  private token: string;
  private debug: boolean;
  
  constructor(core: Runner, options: DiscordAdapterOptions = {}) {
    this.core = core;
    this.showTyping = options.showTyping ?? true;
    this.channelMode = options.channelMode ?? 'mention';
    this.allowedChannelIds = new Set(options.allowedChannelIds ?? []);
    this.debug = options.debug ?? false;
    
    this.token = options.token ?? '';
    if(!this.token) throw new Error('DISCORD_TOKEN is required');
    
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // メッセージ本文を読むために必要
        GatewayIntentBits.DirectMessages
      ],
      partials: [
        Partials.Channel, // DM チャンネルを受け取るために必要
        Partials.Message
      ]
    });
    
    this.sessions = options.sessions ?? new SessionManager({
      persistDir: options.persistDir,
      debug: this.debug
    });
    
    this.registerHandlers();
  }
  
  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------
  
  async start(): Promise<void> {
    await this.client.login(this.token);
    // login() は ready イベントより先に resolve するので
    // ready を待ってからログを出す
    await new Promise<void>(resolve => {
      if(this.client.isReady()) {
        resolve();
        return;
      }
      this.client.once(Events.ClientReady, () => resolve());
    });
    
    this.client.user?.setActivity('🤖 稼働中', { type: ActivityType.Custom });
    console.log(`[DiscordAdapter] Logged in as ${this.client.user?.tag} ⚡`);
  }
  
  async stop(): Promise<void> {
    this.sessions.destroy();
    this.client.destroy();
    console.log('[DiscordAdapter] Stopped.');
  }
  
  // ----------------------------------------------------------------
  // Event handlers
  // ----------------------------------------------------------------
  
  private registerHandlers(): void {
    this.client.on(Events.MessageCreate, async message => {
      // Bot 自身のメッセージは無視
      if(message.author.bot) return;
      
      const isDM = message.channel.type === ChannelType.DM;
      
      if(isDM) {
        // DM はメンション不要で常に反応
        await this.handleMessage(message);
        return;
      }
      
      // パブリックチャンネル・スレッドの処理
      if(this.channelMode === 'mention') {
        // メンションされているかチェック
        if(!message.mentions.has(this.client.user!)) return;
      }
      else {
        // "all" モード: 許可リストがあればチェック
        if(
          this.allowedChannelIds.size > 0 &&
          !this.allowedChannelIds.has(message.channelId)
        ) return;
      }
      
      await this.handleMessage(message);
    });
  }
  
  // ----------------------------------------------------------------
  // Core message handling
  // ----------------------------------------------------------------
  
  private async handleMessage(message: Message): Promise<void> {
    // メンション除去してテキスト取り出し
    const text = this.stripMention(message.content);
    if(!text) return;
    
    // セッションID: チャンネルID ベース
    // スレッドの場合はスレッドID を使うことで親チャンネルと独立した会話になる
    const channelId = message.channelId;
    const sessionId = SessionManager.makeId('discord', channelId);
    
    this.log(`[${sessionId}] "${text.slice(0, 60)}..."`);
    
    // タイピングインジケーター開始
    const typingChannel = message.channel as TextChannel | DMChannel | ThreadChannel;
    if(this.showTyping) {
      await typingChannel.sendTyping().catch(() => {});
    }
    
    // タイピングは約10秒で止まるので、長時間かかる場合は定期的に送り直す
    const typingInterval =
      this.showTyping
        ? setInterval(() => typingChannel.sendTyping().catch(() => {}), 8000)
        : null;
    
    try {
      const result = await this.sessions.chat(sessionId, text, this.core);
      
      if(typingInterval) clearInterval(typingInterval);
      
      // 2000文字制限に対応するため、長い応答は分割して送信
      const chunks = this.splitMessage(result.text);
      for(const chunk of chunks) {
        await message.reply(chunk);
      }
      
      // デバッグ時: tool call サマリーをコンソールに出力
      if(this.debug && result.toolCalls.length > 0) {
        const summary = result.toolCalls
          .map(tc => `• ${tc.name} → ${tc.result.slice(0, 80)}`)
          .join('\n');
        this.log(`Tool calls:\n${summary}`);
      }
    }
    catch(err) {
      if(typingInterval) clearInterval(typingInterval);
      await message.reply('⚠️ エラーが発生しました。しばらくしてからもう一度お試しください。');
      this.log('handleMessage error:', err);
    }
  }
  
  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------
  
  /**
   * Discord の 2000 文字制限に合わせてメッセージを分割する。
   * 単語の途中で切れないよう改行を優先して分割する。
   */
  private splitMessage(text: string, limit = 1900): Array<string> {
    if(text.length <= limit) return [text];
    
    const chunks: Array<string> = [];
    let remaining = text;
    
    while(remaining.length > limit) {
      // limit 以内で最後の改行を探す
      let splitAt = remaining.lastIndexOf('\n', limit);
      if(splitAt <= 0) splitAt = limit;
      
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    
    if(remaining) chunks.push(remaining);
    return chunks;
  }
  
  /** `<＠1234567890> テキスト` → `テキスト` */
  private stripMention(text: string): string {
    return text.replace(/^<@!?\d+>\s*/g, '').trim();
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) {
      console.log(`[DiscordAdapter] ${message}`, ...args);
    }
  }
}