import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

import { SessionManager } from '../agent/session.js';

import type { Runner } from '../agent/core.js';
import type { Request, Response } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));  // eslint-disable-line @typescript-eslint/naming-convention

export interface FrontendServerOptions {
  port?: number;
  /** Web UI の静的ファイルディレクトリ・未指定なら組み込みの簡易 UI を返す */
  publicDir?: string;
  /** `/api/health` で返すモデル名 */
  model?: string;
  /** 外部から注入する SessionManager (未指定なら内部で生成) */
  sessions?: SessionManager;
  debug?: boolean;
}

/** POST `/api/chat` のリクエストボディ */
interface ChatRequest {
  message: string;
  /** 省略時は `web:anonymous` */
  sessionId?: string;
}

/** POST `/api/chat` のレスポンス */
interface ChatResponse {
  text: string;
  sessionId: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string; }>;
  iterations: number;
}

/** WebSocket で受信するメッセージ */
type WsIncoming = { type: 'chat'; message: string; sessionId?: string };

/** WebSocket で送信するメッセージ */
type WsOutgoing =
  | { type: 'chunk'; text: string }  // ストリーミング中のテキスト断片
  | { type: 'done'; sessionId: string; toolCalls: ChatResponse['toolCalls']; iterations: number }
  | { type: 'error'; message: string };

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
    
    this.port     = options.port ?? 58080;
    this.model    = options.model ?? '';
    if(this.model === '') throw new Error('OLLAMA_MODEL Is Required');
    this.debug    = options.debug ?? false;
    
    this.sessions = options.sessions ?? new SessionManager({ debug: this.debug });
    
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    
    this.setupMiddleware(options.publicDir);
    this.setupRoutes();
    this.setupWebSocket();
  }
  
  public start(): Promise<void> {
    return new Promise(resolve => {
      this.server.listen(this.port, () => {
        console.log(`[FrontendServer] Listening On <http://localhost:${this.port}>`);
        resolve();
      });
    });
  }
  
  public stop(): Promise<void> {
    return new Promise(resolve => {
      // 残っている WebSocket 接続を全て強制クローズ
      for(const ws of this.wss.clients) ws.terminate();
      this.wss.close();
      
      // Keep-Alive 接続が残っていても3秒でタイムアウト
      const timer = setTimeout(() => resolve(), 3000);
      this.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  
  private setupMiddleware(publicDir?: string): void {
    this.app.use(express.json());
    
    // 静的ファイル配信
    const staticDir = publicDir ?? path.join(__dirname, 'public');
    this.app.use(express.static(staticDir));
  }
  
  private setupRoutes(): void {
    // ヘルスチェック・LLM モデル名表示
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json({
        status: 'ok',
        model: this.model,
        sessions: this.sessions.size
      });
    });
    
    // チャット (REST)
    this.app.post('/api/chat', async (req: Request, res: Response) => {
      const body = req.body as ChatRequest;
      
      if(body.message?.trim() === '') {
        res.status(400).json({ error: 'Message Is Required' });
        return;
      }
      
      const sessionId = body.sessionId ?? SessionManager.makeId('web', 'anonymous');
      
      try {
        const result = await this.sessions.chat(sessionId, body.message, this.core);
        const response: ChatResponse = { text: result.text, sessionId, toolCalls: result.toolCalls, iterations: result.iterations };
        res.json(response);
      }
      catch(error) {
        this.log('POST /api/chat Error :', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
    });
    
    // 会話履歴のリセット
    this.app.delete('/api/chat/:sessionId', (req: Request, res: Response) => {  // eslint-disable-line neos-eslint-plugin/comment-colon-spacing
      const sessionId = Array.isArray(req.params.sessionId)
        ? req.params.sessionId[0]
        : req.params.sessionId;
      this.sessions.clearHistory(sessionId);
      res.json({ ok: true });
    });
    
    // SPA フォールバック (`public/index.html` が存在する場合)
    this.app.get('/{*path}', (_req: Request, res: Response) => {
      const indexPath = path.join(__dirname, 'public', 'index.html');
      res.sendFile(indexPath, error => {
        if(error != null) res.status(404).send('Not Found');
      });
    });
  }
  
  private setupWebSocket(): void {
    this.wss.on('connection', ws => {
      this.log('WebSocket Connected');
      
      ws.on('message', async raw => {
        let incoming: WsIncoming;
        
        try {
          incoming = JSON.parse(raw.toString()) as WsIncoming;
        }
        catch {
          this.send(ws, { type: 'error', message: 'Invalid JSON' });
          return;
        }
        
        if(incoming.type !== 'chat' || incoming.message == null || incoming.message.trim() === '') {
          this.send(ws, { type: 'error', message: 'Invalid Message Format' });
          return;
        }
        
        const sessionId = incoming.sessionId ?? SessionManager.makeId('web', 'anonymous');
        
        try {
          // AgentCore は現状ストリーミング非対応のため完了後に全文を1チャンクとして送信する
          // 将来 `core.stream()` を実装したら Chunk を細かく送れる
          const result = await this.sessions.chat(sessionId, incoming.message, this.core);
          
          this.send(ws, { type: 'chunk', text: result.text });
          this.send(ws, {
            type: 'done',
            sessionId,
            toolCalls: result.toolCalls,
            iterations: result.iterations
          });
        }
        catch(error) {
          this.log('WebSocket Chat Error :', error);
          this.send(ws, { type: 'error', message: 'Agent Error' });
        }
      });
      
      ws.on('close', () => this.log('WebSocket Disconnected'));
    });
  }
  
  private send(ws: WebSocket, data: WsOutgoing): void {
    if(ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }
  
  private log(message: string, ...args: Array<unknown>): void {
    if(this.debug) console.log(`[FrontendServer] ${message}`, ...args);
  }
}
