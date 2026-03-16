import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentCore, Runner } from "../agent/core.js";
import { SessionManager } from "../agent/session.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----------------------------------------------------------------
// Types
// ----------------------------------------------------------------

export interface FrontendServerOptions {
  port?: number;
  /** Web UI の静的ファイルディレクトリ。未指定なら組み込みの簡易UIを返す */
  publicDir?: string;
  /** /api/health で返すモデル名 */
  model?: string;
  /** 外部から注入する SessionManager（未指定なら内部で生成） */
  sessions?: SessionManager;
  debug?: boolean;
}

/** POST /api/chat のリクエストボディ */
interface ChatRequest {
  message: string;
  /** 省略時は "web:anonymous" */
  sessionId?: string;
}

/** POST /api/chat のレスポンス */
interface ChatResponse {
  text: string;
  sessionId: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>;
  iterations: number;
}

/** WebSocket で送受信するメッセージ */
type WsIncoming = { type: "chat"; message: string; sessionId?: string };
type WsOutgoing =
  | { type: "chunk"; text: string }        // ストリーミング中のテキスト断片
  | { type: "done"; sessionId: string; toolCalls: ChatResponse["toolCalls"]; iterations: number }
  | { type: "error"; message: string };

// ----------------------------------------------------------------
// FrontendServer
// ----------------------------------------------------------------

export class FrontendServer {
  private app = express();
  private server: http.Server;
  private wss: WebSocketServer;
  private sessions: SessionManager;
  private core: Runner;
  private port: number;
  private model: string;
  private debug: boolean;

  constructor(core: Runner, options: FrontendServerOptions = {}) {
    this.core = core;
    this.port = options.port ?? 58080;
    this.model = options.model ?? "qwen2.5:14b-instruct-q4_k_m";
    this.debug = options.debug ?? false;

    this.sessions = options.sessions ?? new SessionManager({ debug: this.debug });

    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.setupMiddleware(options.publicDir);
    this.setupRoutes();
    this.setupWebSocket();
  }

  // ----------------------------------------------------------------
  // Public API
  // ----------------------------------------------------------------

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`[FrontendServer] Listening on http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      // 残っている WebSocket 接続を全て強制クローズ
      for (const ws of this.wss.clients) {
        ws.terminate();
      }
      this.wss.close();

      // Keep-Alive 接続が残っていても 3 秒でタイムアウト
      const timer = setTimeout(() => resolve(), 3000);
      this.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ----------------------------------------------------------------
  // Setup
  // ----------------------------------------------------------------

  private setupMiddleware(publicDir?: string): void {
    this.app.use(express.json());

    // 静的ファイル配信
    const staticDir = publicDir ?? path.join(__dirname, "public");
    this.app.use(express.static(staticDir));
  }

  private setupRoutes(): void {
    // ヘルスチェック
    this.app.get("/api/health", (_req: Request, res: Response) => {
      res.json({
        status: "ok",
        model: this.model,
        sessions: this.sessions.size,
      });
    });

    // チャット（REST）
    this.app.post("/api/chat", async (req: Request, res: Response) => {
      const body = req.body as ChatRequest;

      if (!body.message?.trim()) {
        res.status(400).json({ error: "message is required" });
        return;
      }

      const sessionId = body.sessionId ?? SessionManager.makeId("web", "anonymous");

      try {
        const result = await this.sessions.chat(sessionId, body.message, this.core);
        const response: ChatResponse = { text: result.text, sessionId, toolCalls: result.toolCalls, iterations: result.iterations };
        res.json(response);
      } catch (err) {
        this.log("POST /api/chat error:", err);
        res.status(500).json({ error: "Internal server error" });
      }
    });

    // 会話履歴のリセット
    this.app.delete("/api/chat/:sessionId", (req: Request, res: Response) => {
      const sessionId = Array.isArray(req.params.sessionId)
        ? req.params.sessionId[0]
        : req.params.sessionId;
      this.sessions.clearHistory(sessionId);
      res.json({ ok: true });
    });

    // SPA フォールバック（public/index.html が存在する場合）
    this.app.get("/{*path}", (_req: Request, res: Response) => {
      const indexPath = path.join(__dirname, "public", "index.html");
      res.sendFile(indexPath, (err) => {
        if (err) res.status(404).send("Not found");
      });
    });
  }

  private setupWebSocket(): void {
    this.wss.on("connection", (ws) => {
      this.log("WebSocket connected");

      ws.on("message", async (raw) => {
        let incoming: WsIncoming;

        try {
          incoming = JSON.parse(raw.toString()) as WsIncoming;
        } catch {
          this.send(ws, { type: "error", message: "Invalid JSON" });
          return;
        }

        if (incoming.type !== "chat" || !incoming.message?.trim()) {
          this.send(ws, { type: "error", message: "Invalid message format" });
          return;
        }

        const sessionId = incoming.sessionId ?? SessionManager.makeId("web", "anonymous");

        try {
          // AgentCore は現状ストリーミング非対応のため、
          // 完了後に全文を1チャンクとして送信する。
          // 将来 core.stream() を実装したら chunk を細かく送れる。
          const result = await this.sessions.chat(sessionId, incoming.message, this.core);

          this.send(ws, { type: "chunk", text: result.text });
          this.send(ws, {
            type: "done",
            sessionId,
            toolCalls: result.toolCalls,
            iterations: result.iterations,
          });
        } catch (err) {
          this.log("WebSocket chat error:", err);
          this.send(ws, { type: "error", message: "Agent error" });
        }
      });

      ws.on("close", () => this.log("WebSocket disconnected"));
    });
  }

  // ----------------------------------------------------------------
  // Private helpers
  // ----------------------------------------------------------------

  private send(ws: WebSocket, data: WsOutgoing): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  private log(message: string, ...args: unknown[]): void {
    if (this.debug) {
      console.log(`[FrontendServer] ${message}`, ...args);
    }
  }
}