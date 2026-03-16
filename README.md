# Neo's Claw

Ollama 上のローカル LLM を使った、軽量・自作エージェントフレームワーク。

MCP (Model Context Protocol) でツールを管理し、Web UI・Slack・Discord の複数チャネルから同時に操作できる。


## ユースケース

### note・Zenn 記事ネタ判定

書きたいテーマを投げると、note・Zenn の類似記事を自動リサーチして「ウケそうか・お布施に繋がりそうか」を判定する。

```
ユーザ : 「Node.js で MCP サーバを自作する話、記事にしようと思うんだけどどう？」

エージェント :
📊 記事ネタ判定 ：「Node.js で MCP サーバを自作する」

▶ note   ★★★☆☆  有料向き △
▶ Zenn   ★★★★☆  有料向き ◎

📈 類似記事の傾向
  - いいね平均 : 47 / 有料設定あり : 3/12件 (25%)
  - ニッチ度 : 高 (競合少ない)

💡 差別化ポイント
  Ollama との統合まで踏み込むと刺さりそう

✅ 結論 : Zenn で有料記事にするのがおすすめ
```

判定フロー :

1. note・Zenn の類似記事を検索
2. Fetch MCP で記事ページを取得・いいね数・有料設定の有無を確認
3. ニッチ度・競合数・反応を総合スコアリング
4. 差別化ポイントの提案とプラットフォーム推奨を返す

Slack・Discord にはコンパクト版、Web UI には記事リンク一覧・詳細スコアを表示。


## コンポーネント詳細

### Agent Core

エージェントの中核。Ollama にメッセージを送り、Tool Call が返ってきたら MCP 経由でツールを実行、結果を会話履歴に追加して再度送信する、というループを回す。

- **ReAct ループ** : Reasoning → Action (Tool Call) → Observation (Tool Result) → 繰り返し
- **セッション管理** : ユーザごとに会話履歴を保持 (メモリ上 or ファイル永続化)
- **システムプロンプト管理** : タスク種別に応じてプロンプトを差し替え可能

### Frontend Server

Express ベースの HTTP サーバ。ブラウザから直接エージェントにアクセスできる Web UI を提供する。

- **REST API** : `/api/chat` エンドポイント (POST)
- **WebSocket** : ストリーミング応答対応 (`ws`)
- **Web UI** : シンプルなチャット画面 (HTML + Vanilla CSS・JS)

### Bot Adapters

Slack・Discord を同時に起動できる。それぞれ独立したアダプタとして実装し、どちらのチャネルから来たメッセージも Agent Core に渡す薄いアダプタ層。

セッションIDはチャネル種別のプレフィックスで区別するため、Agent Core 側はチャネルを意識しない。

```
slack:C012AB3CD:U012AB3CD   # Slack チャンネル : ユーザ
discord:123456789012345678  # Discord チャンネル ID
web:session-uuid            # Web UI セッション
```

Slack または Discord のどちらかを起動時に選択する。エージェントコアを呼び出す薄いアダプタ層として実装し、チャネルやスレッドをセッション ID にマッピングする。

- **Slack** : Bolt For JavaScript (`@slack/bolt`) … `SLACK_ENABLED=true` で起動
- **Discord** : Discord.js (`discord.js`) … `DISCORD_ENABLED=true` で起動
- 両方 `true` にすれば同時稼動。片方だけでも動作する


### MCP Client

Agent Core に組み込まれる MCP クライアント。設定ファイルに列挙した MCP サーバを起動時に `stdio` で `spawn` し、ツール一覧を取得してエージェントに渡す。

### MCP Servers (`stdio`・軽量)

| サーバ       | 用途                            | パッケージ                                |
|--------------|---------------------------------|-------------------------------------------|
| Filesystem   | ファイル読み書き・検索          | `@modelcontextprotocol/server-filesystem` |
| Fetch        | URL 取得・Web スクレイピング    | `@modelcontextprotocol/server-fetch`      |
| Memory       | 会話間の永続メモリ (知識グラフ) | `@modelcontextprotocol/server-memory`     |
| Custom       | 自作ツール (Playwright 等)      | `./mcp-servers/` 以下に追加               |

すべて `stdio` トランスポートで動作。常駐プロセスではなく、エージェント起動時に子プロセスとして `spawn` され、終了時に一緒に落ちる。


## ディレクトリ構成

```
neos-claw/
├ src/
│ ├ index.ts        # エントリポイント (全アダプター同時起動)
│ ├ agent/
│ │ ├ core.ts      # ReAct ループ本体
│ │ ├ session.ts   # セッション・会話履歴管理
│ │ └ prompt.ts    # システムプロンプト構築
│ ├ mcp/
│ │ ├ client.ts    # MCPクライアント (spawn + stdio)
│ │ └ registry.ts  # ツール一覧の管理
│ ├ server/
│ │ ├ app.ts       # Express サーバ
│ │ ├ ws.ts        # WebSocket ハンドラ
│ │ └ public/      # Web UI 静的ファイル
│ └ adapters/
│    ├ slack.ts     # Slack Bolt アダプタ
│    └ discord.ts   # Discord アダプタ
├ mcp-servers/
│ └ custom/         # 自作MCPサーバ置き場
├ memory/            # Memory MCP の永続データ
├ mcp-config.json    # MCPサーバ設定
├ .env               # APIキー・環境変数
├ package.json
└ README.md
```


## 依存パッケージ

### `dependencies`

| パッケージ名              | 概要                   |
|---------------------------|------------------------|
| @modelcontextprotocol/sdk | MCP SDK                |
| @slack/bolt               | Slack SDK              |
| discord.js                | Discord SDK            |
| dotenv                    | 環境変数読み込み       |
| express                   | フロントエンドサーバ用 |
| ollama                    | Ollama                 |
| ws                        | フロントエンドサーバ用 |

### `devDependencies`

| パッケージ名               | 概要       |
|----------------------------|------------|
| @eslint/js                 | ESLint     |
| @neos21/neos-eslint-plugin | ESLint     |
| @types/express             | 型定義     |
| @types/node                | TypeScript |
 | @types/ws                 | 型定義     |
| eslint                     | ESLint     |
| eslint-plugin-import       | ESLint     |
| globals                    | ESLint     |
| jiti                       | ESLint     |
| tsx                        | 実行       |
| typescript                 | TypeScript |
| typescript-eslint          | ESLint     |


## 起動方法

```bash
# 依存インストール
$ npm install

# Ollama でモデルを取得
$ ollama pull qwen2.5:14b-instruct-q4_k_m

# 起動 (Web UI + Bot が同時に立ち上がる)
$ npm start
```


## 今後の拡張候補

- [ ] タスク種別に応じた 7B / 14B モデル自動切り替え
- [ ] Playwright を使ったカスタム MCP サーバ (より詳細なスクレイピング)
- [ ] ハートビート (定期実行タスク・朝のトレンド収集など)
- [ ] タスクキュー (複数リクエストの非同期処理)
- [ ] Web UI のストリーミング表示


## Links

- [Neo's World](https://neos21.net/)
