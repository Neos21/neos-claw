import 'dotenv/config';
import { resolve } from 'node:path';

import { DiscordAdapter } from './adapters/discord.js';
import { SlackAdapter } from './adapters/slack.js';
import { AgentCore } from './agent/core.js';
import { McpClient } from './mcp/client.js';
import { FrontendServer } from './server/app.js';

const isDebugMode      = process.env.DEBUG === 'true';
const mcpConfig        = resolve(process.env.MCP_CONFIG ?? './mcp-config.json');
const isSlackEnabled   = process.env.SLACK_ENABLED === 'true';
const isDiscordEnabled = process.env.DISCORD_ENABLED === 'true';
const isWebEnabled     = process.env.WEB_ENABLED !== 'false';  // デフォルト有効

/** 起動する */
async function main(): Promise<void> {
  console.log('🤖 Neo\'s Claw Starting...\n');
  
  // 1. AgentCore を初期化する
  const core = new AgentCore({ debug: isDebugMode });
  console.log(`  ✅ AgentCore Ready (Model : ${process.env.OLLAMA_MODEL ?? 'qwen2.5:14b-instruct-q4_k_m'})`);
  
  // 2. MCP サーバを起動してツールを登録する
  const mcpClient = new McpClient({ debug: isDebugMode });
  await mcpClient.loadConfig(mcpConfig, core);
  console.log(`  ✅ MCP Tools : ${mcpClient.getToolNames()!.join(', ') || '(None)'}`);  // eslint-disable-line @typescript-eslint/strict-boolean-expressions
  
  // 3. 各アダプタを起動する
  const adapters: Array<{ stop: () => Promise<void> }> = [];
  
  if(isWebEnabled) {
    const server = new FrontendServer(core, { debug: isDebugMode });
    await server.start();
    console.log('  ✅ Web UI Ready');
    adapters.push(server);
  }
  
  if(isSlackEnabled) {
    const slack = new SlackAdapter(core, {
      persistDir: './sessions/slack',
      debug: isDebugMode
    });
    await slack.start();
    console.log('  ✅ Slack Adapter Ready');
    adapters.push(slack);
  }
  
  if(isDiscordEnabled) {
    const discord = new DiscordAdapter(core, {
      persistDir: './sessions/discord',
      debug: isDebugMode
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
    // 二重実行防止 (Ctrl+C を連打しても1回だけ実行)
    if(isShuttingDown) {
      console.log('  (Force Exit)');
      process.exit(1);
    }
    isShuttingDown = true;
    console.log(`\n[${signal}] Shutting Down...`);
    
    // 5 秒以内に終わらなければ強制終了
    const forceExit = setTimeout(() => {
      console.error('  Shutdown Timed Out. Force Exiting');
      process.exit(1);
    }, 5000);
    forceExit.unref();
    
    // 全アダプターを停止する
    await Promise.allSettled(adapters.map(adapter => adapter.stop()));
    
    // MCP サーバ (子プロセス) を全停止する
    await mcpClient.shutdown();
    
    clearTimeout(forceExit);
    console.log('👋 Goodbye');
    process.exit(0);
  };
  
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  
  // 未捕捉エラーのログ (クラッシュしないようにする)
  process.on('uncaughtException', error => {
    console.error('[uncaughtException]', error);
  });
  process.on('unhandledRejection', reason => {
    console.error('[unhandledRejection]', reason);
  });
}

main().catch(error => {
  console.error('Fatal Error During Startup :', error);
  process.exit(1);
});
