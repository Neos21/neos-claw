import { Client, GatewayIntentBits, Partials, Events, ChannelType, ActivityType, type Message, type TextChannel, type DMChannel, type ThreadChannel } from 'discord.js';

import { SessionManager } from '../agent/session.js';

import type { Runner } from '../agent/core.js';

export interface DiscordAdapterOptions {
  /** Discord Bot Token */
  token?: string;
  /** エージェントが処理中であることを示すタイピングインジケータ・デフォルト `true` */
  showTyping?: boolean;
  /**
   * パブリックチャンネルでの動作モード
   * 
   * - `mention` : メンション (@bot) のみ反応 (デフォルト)
   * - `all`     : 全メッセージに反応 (プライベートチャンネル・専用チャンネル向け)
   */
  channelMode?: 'mention' | 'all';
  /** `all` モード時に反応するチャンネル ID の許可リスト・未指定なら全チャンネルで反応する */
  allowedChannelIds?: Array<string>;
  /** セッションの永続化ディレクトリ */
  persistDir?: string;
  debug?: boolean;
}

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
    
    this.token = options.token ?? process.env.DISCORD_TOKEN ?? '';
    if(this.token === '') throw new Error('DISCORD_TOKEN Is Required');
    
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,  // メッセージ本文を読むために Discord Developer Portal でボットの設定時に必要なので注意
        GatewayIntentBits.DirectMessages
      ],
      partials: [
        Partials.Channel,  // DM チャンネルを受け取るために必要
        Partials.Message
      ]
    });
    
    this.sessions = new SessionManager({
      persistDir: options.persistDir,
      debug: this.debug
    });
    
    this.registerHandlers();
  }
  
  public async start(): Promise<void> {
    await this.client.login(this.token);
    // `login()` は `ready` イベントより先に `resolve` するので `ready` を待ってからログを出す
    await new Promise<void>(resolve => {
      if(this.client.isReady()) {
        resolve();
        return;
      }
      this.client.once(Events.ClientReady, () => resolve());
    });
    
    this.client.user?.setActivity('🤖 稼動中', { type: ActivityType.Custom });
    console.log(`[DiscordAdapter] Logged In As ${this.client.user?.tag} ⚡`);
  }
  
  public async stop(): Promise<void> {
    this.sessions.destroy();
    this.client.destroy();
    console.log('[DiscordAdapter] Stopped');
  }
  
  private registerHandlers(): void {
    this.client.on(Events.MessageCreate, async message => {
      // Bot 自身のメッセージは無視する
      if(message.author.bot) return;
      
      const isDM = message.channel.type === ChannelType.DM;
      
      if(isDM) {
        // DM はメンション不要で常に反応する
        await this.handleMessage(message);
        return;
      }
      
      // パブリックチャンネル・スレッドの処理
      if(this.channelMode === 'mention') {
        // メンションされているかチェックする
        if(!message.mentions.has(this.client.user!)) return;
      }
      else {
        // `all` モード : 許可リストがあればチェック
        if(this.allowedChannelIds.size > 0 && !this.allowedChannelIds.has(message.channelId)) return;
      }
      
      await this.handleMessage(message);
    });
  }
  
  private async handleMessage(message: Message): Promise<void> {
    // メンション除去してテキスト取り出し
    const text = this.stripMention(message.content);
    if(text === '') return;
    
    // セッション ID : チャンネル ID ベース
    // スレッドの場合はスレッド ID を使うことで親チャンネルと独立した会話になる
    const channelId = message.channelId;
    const sessionId = SessionManager.makeId('discord', channelId);
    
    this.log(`[${sessionId}] "${text.slice(0, 60)}..."`);
    
    // タイピングインジケータ開始
    const typingChannel = message.channel as TextChannel | DMChannel | ThreadChannel;
    if(this.showTyping) {
      await typingChannel.sendTyping().catch(() => {});
    }
    
    // タイピングは約10秒で止まるので長時間かかる場合は定期的に送り直す
    const typingInterval = this.showTyping ? setInterval(() => typingChannel.sendTyping().catch(() => {}), 8000) : null;
    
    try {
      const result = await this.sessions.chat(sessionId, text, this.core);
      
      if(typingInterval != null) clearInterval(typingInterval);
      
      // 2000文字制限に対応するため、長い応答は分割して送信する
      const chunks = this.splitMessage(result.text);
      for(const chunk of chunks) {
        await message.reply(chunk);
      }
      
      // デバッグ時 : Tool Call サマリーをコンソールに出力する
      if(this.debug && result.toolCalls.length > 0) {
        const summary = result.toolCalls
          .map(tc => `• ${tc.name} → ${tc.result.slice(0, 80)}`)
          .join('\n');
        this.log(`Tool Calls :\n${summary}`);
      }
    }
    catch(err) {
      if(typingInterval != null) clearInterval(typingInterval);
      await message.reply('⚠️ エラーが発生しました。しばらくしてからもう一度お試しください。');
      this.log('Handle Message Error:', err);
    }
  }
  
  /** Discord の 2000 文字制限に合わせてメッセージを分割する・単語の途中で切れないよう改行を優先して分割する */
  private splitMessage(text: string, limit = 1900): Array<string> {
    if(text.length <= limit) return [text];
    
    const chunks: Array<string> = [];
    let remaining = text;
    
    while(remaining.length > limit) {
      // `limit` 以内で最後の改行を探す
      let splitAt = remaining.lastIndexOf('\n', limit);
      if(splitAt <= 0) splitAt = limit;
      
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    
    if(remaining !== '') chunks.push(remaining);
    return chunks;
  }
  
  /** `<＠1234567890> テキスト` → `テキスト` */
  private stripMention(text: string): string {
    return text.replace(/^<@!?\d+>\s*/g, '').trim();
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) console.log(`[DiscordAdapter] ${message}`, ...args);
  }
}
