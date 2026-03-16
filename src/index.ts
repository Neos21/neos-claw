import 'dotenv/config';
import { resolve } from 'node:path';

import { DiscordAdapter } from './adapters/discord.js';
import { SlackAdapter } from './adapters/slack.js';
import { AgentCore } from './agent/core.js';
import { SessionManager } from './agent/session.js';
import { ToolProxy } from './agent/tool-proxy.js';
import { ArticleResearcher } from './features/article-research/index.js';
import { McpClient } from './mcp/client.js';
import { FrontendServer } from './server/app.js';

/** AppConfig : 環境変数の読み取りはここだけ */
const config = {
  debug            : process.env.DEBUG === 'true',
  mcpConfig        : resolve(process.env.MCP_CONFIG ?? './mcp-config.json'),
  // Ollama
  ollamaHost       : process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  ollamaModel      : process.env.OLLAMA_MODEL ?? 'qwen2.5:14b-instruct-q4_k_m',
  // セッション永続化
  sessionPersistDir: process.env.SESSION_PERSIST_DIR ?? './sessions',
  // Web UI
  webEnabled       : process.env.WEB_ENABLED !== 'false',
  port             : Number(process.env.PORT ?? 58080),
  // MCP Workspace
  mcpWorkspace     : process.env.MCP_WORKSPACE ?? resolve('./workspace'),
  // Slack
  slackEnabled     : process.env.SLACK_ENABLED === 'true',
  slackBotToken    : process.env.SLACK_BOT_TOKEN,
  slackAppToken    : process.env.SLACK_APP_TOKEN,
  // Discord
  discordEnabled   : process.env.DISCORD_ENABLED === 'true',
  discordToken     : process.env.DISCORD_TOKEN
} as const;

/** 起動 */
const main = async (): Promise<void> => {
  console.log('🤖 Neo\'s Claw Starting...\n');
  
  // Ollama 関連の環境変数を出力 (設定されているものだけ)
  const ollamaKeys = [
    'OLLAMA_HOST',
    'OLLAMA_MODEL',
    'OLLAMA_KEEP_ALIVE',
    'OLLAMA_NUM_GPU',
    'OLLAMA_MAX_LOADED_MODELS',
    'OLLAMA_FLASH_ATTENTION',
    'OLLAMA_KV_CACHE_TYPE',
    'OLLAMA_NUM_PARALLEL',
    'OLLAMA_MAX_QUEUE',
    'OLLAMA_CONTEXT_LENGTH'
  ];
  const setKeys = ollamaKeys.filter(key => process.env[key] != null);
  if(setKeys.length > 0) {
    console.log('  📋 Ollama Environment Variables :');
    for(const key of setKeys) console.log(`     ${key}=${process.env[key]}`);
    console.log('');
  }
  
  // 1. AgentCore を初期化
  const core = new AgentCore({
    ollamaHost: config.ollamaHost,
    model     : config.ollamaModel,
    debug     : config.debug
  });
  const sharedSessions = new SessionManager({
    persistDir: config.sessionPersistDir,
    debug     : config.debug
  });
  const proxy = new ToolProxy(core, sharedSessions, {
    allowedDir: config.mcpWorkspace,
    debug     : config.debug
  });
  console.log(`  ✅ AgentCore Ready (Model : ${config.ollamaModel})`);
  
  // 2. MCP サーバを起動してツールを登録
  const mcpClient = new McpClient({ debug: config.debug });
  await mcpClient.loadConfig(config.mcpConfig, core);
  console.log(`  ✅ MCP Tools : ${mcpClient.getToolNames().join(', ') || '(None)'}`);  // eslint-disable-line @typescript-eslint/strict-boolean-expressions
  
  // 記事ネタ判定ツールを AgentCore に登録
  const articleResearcher = new ArticleResearcher(core, { debug: config.debug });
  core.registerTool({
    name: 'research_article_topic',
    description: 'note と Zenn で記事テーマの市場調査を行い、ウケそうか・有料化できそうかを判定してレポートを返す。記事ネタ・テーマの相談に使う。',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '調査したい記事テーマ (日本語可) ' }
      },
      required: ['topic']
    },
    execute: async args => {
      const topic = typeof args.topic === 'string' ? args.topic : String(args.topic);
      return articleResearcher.researchAndFormat(topic);
    }
  });
  console.log('  ✅ Article Research Tool Ready');
  
  // 3. 各アダプターを起動
  const adapters: Array<{ stop: () => Promise<void>; }> = [];
  
  if(config.webEnabled) {
    const server = new FrontendServer(proxy, {
      port    : config.port,
      model   : config.ollamaModel,
      sessions: sharedSessions,
      debug   : config.debug
    });
    await server.start();
    console.log(`  ✅ Web UI Ready <http://localhost:${config.port}>`);
    adapters.push(server);
  }
  
  if(config.slackEnabled) {
    const slack = new SlackAdapter(proxy, {
      botToken  : config.slackBotToken,
      appToken  : config.slackAppToken,
      persistDir: `${config.sessionPersistDir}/slack`,
      sessions  : sharedSessions,
      debug     : config.debug
    });
    await slack.start();
    console.log('  ✅ Slack Adapter Ready');
    adapters.push(slack);
  }
  
  if(config.discordEnabled) {
    const discord = new DiscordAdapter(proxy, {
      token     : config.discordToken,
      persistDir: `${config.sessionPersistDir}/discord`,
      sessions  : sharedSessions,
      debug     : config.debug
    });
    await discord.start();
    console.log('  ✅ Discord Adapter Ready');
    adapters.push(discord);
  }
  
  if(adapters.length === 0) {
    console.warn('\n  ⚠️  有効なアダプターがありません');
    console.warn('     `.env` で `WEB_ENABLED=true`・`SLACK_ENABLED=true`・`DISCORD_ENABLED=true` を設定してください\n');
  }
  
  console.log('\n🚀 Neo\'s Claw Is Running. Ctrl+C To Stop\n');
  
  /** グレースフルシャットダウン */
  let isShuttingDown = false;
  
  const shutdown = async (signal: string): Promise<void> => {
    if(isShuttingDown) {
      console.log('  (Force Exit)');
      process.exit(1);
    }
    isShuttingDown = true;
    console.log(`\n[${signal}] Shutting Down...`);
    
    const forceExit = setTimeout(() => {
      console.error('  Shutdown Timed Out. Force Exiting');
      process.exit(1);
    }, 5000);
    forceExit.unref();
    
    await Promise.allSettled(adapters.map(adapter => adapter.stop()));
    await mcpClient.shutdown();
    
    clearTimeout(forceExit);
    console.log('👋 Goodbye');
    process.exit(0);
  };
  
  process.on('SIGINT' , () => shutdown('SIGINT' ));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  
  process.on('uncaughtException' , error  => console.error('[uncaughtException]' , error ));
  process.on('unhandledRejection', reason => console.error('[unhandledRejection]', reason));
};

main().catch(error => {
  console.error('Fatal Error During Startup :', error);
  process.exit(1);
});
