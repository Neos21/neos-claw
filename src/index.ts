import "dotenv/config";
import { resolve } from "node:path";
import { AgentCore } from "./agent/core.js";
import { ToolProxy } from "./agent/tool-proxy.js";
import { SessionManager } from "./agent/session.js";
import { McpClient } from "./mcp/client.js";
import { FrontendServer } from "./server/app.js";
import { SlackAdapter } from "./adapters/slack.js";
import { DiscordAdapter } from "./adapters/discord.js";

// ----------------------------------------------------------------
// AppConfig — 環境変数の読み取りはここだけ
// ----------------------------------------------------------------

const config = {
  debug:          process.env.DEBUG === "true",
  mcpConfig:      resolve(process.env.MCP_CONFIG ?? "./mcp-config.json"),

  // Ollama
  ollamaHost:     process.env.OLLAMA_HOST ?? "http://localhost:11434",
  ollamaModel:    process.env.OLLAMA_MODEL ?? "qwen2.5:14b-instruct-q4_k_m",

  // Web UI
  webEnabled:     process.env.WEB_ENABLED !== "false",
  port:           Number(process.env.PORT ?? 58080),

  // MCP workspace
  mcpWorkspace:   process.env.MCP_WORKSPACE ?? resolve("./workspace"),

  // Slack
  slackEnabled:       process.env.SLACK_ENABLED === "true",
  slackBotToken:      process.env.SLACK_BOT_TOKEN,
  slackAppToken:      process.env.SLACK_APP_TOKEN,

  // Discord
  discordEnabled:     process.env.DISCORD_ENABLED === "true",
  discordToken:       process.env.DISCORD_TOKEN,
} as const;

// ----------------------------------------------------------------
// 起動
// ----------------------------------------------------------------

async function main(): Promise<void> {
  console.log("🤖 LightAgent starting...\n");

  // Ollama 関連の環境変数を出力（設定されているものだけ）
  const OLLAMA_KEYS = [
    "OLLAMA_HOST", "OLLAMA_MODEL", "OLLAMA_KEEP_ALIVE",
    "OLLAMA_NUM_GPU", "OLLAMA_MAX_LOADED_MODELS",
    "OLLAMA_FLASH_ATTENTION", "OLLAMA_KV_CACHE_TYPE",
    "OLLAMA_NUM_PARALLEL", "OLLAMA_MAX_QUEUE", "OLLAMA_CONTEXT_LENGTH",
  ];
  const setKeys = OLLAMA_KEYS.filter((k) => process.env[k] != null);
  if (setKeys.length > 0) {
    console.log("  📋 Ollama environment variables:");
    for (const k of setKeys) console.log(`     ${k}=${process.env[k]}`);
    console.log();
  }

  // 1. AgentCore を初期化
  const core = new AgentCore({
    ollamaHost: config.ollamaHost,
    model:      config.ollamaModel,
    debug:      config.debug,
  });
  const sharedSessions = new SessionManager({ debug: config.debug });
  const proxy = new ToolProxy(core, sharedSessions, {
    allowedDir: config.mcpWorkspace,
    debug:      config.debug,
  });
  console.log(`  ✅ AgentCore ready (model: ${config.ollamaModel})`);

  // 2. MCP サーバーを起動してツールを登録
  const mcpClient = new McpClient({ debug: config.debug });
  await mcpClient.loadConfig(config.mcpConfig, core);
  console.log(`  ✅ MCP tools: ${mcpClient.getToolNames().join(", ") || "(none)"}`);

  // 3. 各アダプターを起動
  const adapters: Array<{ stop: () => Promise<void> }> = [];

  if (config.webEnabled) {
    const server = new FrontendServer(proxy, {
      port:     config.port,
      model:    config.ollamaModel,
      sessions: sharedSessions,
      debug:    config.debug,
    });
    await server.start();
    console.log(`  ✅ Web UI ready (http://localhost:${config.port})`);
    adapters.push(server);
  }

  if (config.slackEnabled) {
    const slack = new SlackAdapter(proxy, {
      botToken:   config.slackBotToken,
      appToken:   config.slackAppToken,
      persistDir: "./sessions/slack",
      sessions:   sharedSessions,
      debug:      config.debug,
    });
    await slack.start();
    console.log("  ✅ Slack adapter ready");
    adapters.push(slack);
  }

  if (config.discordEnabled) {
    const discord = new DiscordAdapter(proxy, {
      token:      config.discordToken,
      persistDir: "./sessions/discord",
      sessions:   sharedSessions,
      debug:      config.debug,
    });
    await discord.start();
    console.log("  ✅ Discord adapter ready");
    adapters.push(discord);
  }

  if (adapters.length === 0) {
    console.warn("\n  ⚠️  有効なアダプターがありません。");
    console.warn("     `.env` で WEB_ENABLED=true / SLACK_ENABLED=true / DISCORD_ENABLED=true を設定してください。\n");
  }

  console.log(`\n🚀 LightAgent is running. Ctrl+C to stop.\n`);

  // ----------------------------------------------------------------
  // グレースフルシャットダウン
  // ----------------------------------------------------------------

  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) {
      console.log("  (force exit)");
      process.exit(1);
    }
    isShuttingDown = true;
    console.log(`\n[${signal}] Shutting down...`);

    const forceExit = setTimeout(() => {
      console.error("  Shutdown timed out. Force exiting.");
      process.exit(1);
    }, 5000);
    forceExit.unref();

    await Promise.allSettled(adapters.map((a) => a.stop()));
    await mcpClient.shutdown();

    clearTimeout(forceExit);
    console.log("👋 Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("uncaughtException",  (err)    => console.error("[uncaughtException]", err));
  process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});