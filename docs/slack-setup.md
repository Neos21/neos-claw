# Slack Bot 設定手順


## 必要なトークン

| 変数              | 説明                                                             |
|-------------------|------------------------------------------------------------------|
| `SLACK_BOT_TOKEN` | `xoxb-` で始まるトークン。Bot がメッセージを送受信するために使う |
| `SLACK_APP_TOKEN` | `xapp-` で始まるトークン。Socket Mode の接続に使う               |


## 手順

### 1. Slack App を作成する

1. <https://api.slack.com/apps> を開く
2. **Create New App** → **From scratch** を選択
3. App Name（例: `Neo's Claw`）と対象ワークスペースを入力して **Create App**

### 2. Socket Mode を有効にする

1. 左メニュー **Settings → Socket Mode** を開く
2. **Enable Socket Mode** をオンにする
3. Token Name（例: `lightagent-socket`）を入力して **Generate**
4. 表示された `xapp-...` トークンをコピー → `.env` の `SLACK_APP_TOKEN` に貼る

### 3. Bot Token Scopes を設定する

1. 左メニュー **Features → OAuth & Permissions** を開く
2. **Bot Token Scopes** に以下を追加する

| Scope               | 用途                                   |
|---------------------|----------------------------------------|
| `app_mentions:read` | メンションを受け取る                   |
| `chat:write`        | メッセージを送信する                   |
| `chat:write.public` | 参加していないチャンネルにも送信する   |
| `im:history`        | DM の履歴を読む                        |
| `im:read`           | DM チャンネルの一覧を読む              |
| `im:write`          | DM を開始する                          |
| `channels:history`  | パブリックチャンネルのメッセージを読む |
| `commands`          | `/reset` スラッシュコマンドを使う      |

3. ページ上部の **Install to Workspace** をクリックして認証
4. 表示された `xoxb-...` トークンをコピー → `.env` の `SLACK_BOT_TOKEN` に貼る

### 4. Event Subscriptions を設定する

1. 左メニュー **Features → Event Subscriptions** を開く
2. **Enable Events** をオンにする (Socket Mode の場合、Request URL は不要)
3. **Subscribe to bot events** に以下を追加する

| Event         | 用途                     |
|---------------|--------------------------|
| `app_mention` | チャンネルでのメンション |
| `message.im`  | DM のメッセージ          |

4. **Save Changes**

### 5. スラッシュコマンドを追加する (オプション)

1. 左メニュー **Features → Slash Commands** を開く
2. **Create New Command** をクリック
3. 以下を入力する
   - Command : `/reset`
   - Short Description : `会話履歴をリセット`
4. **Save**

### 6. App をワークスペースにインストール (再インストール)

Scope やイベントを変更した場合は再インストールが必要です。

1. **Settings → Install App** から **Reinstall to Workspace** をクリック

### 7. 動作確認

```bash
# .env を設定してから起動
$ SLACK_ENABLED=true npm start
```

- DM でボットに話しかける
- パブリックチャンネルでボットをメンション（`@Neo's Claw こんにちは`）


## トラブルシューティング

- **`SLACK_APP_TOKEN is required` エラー**
  - → Socket Mode 用の `xapp-` トークンが `.env` に設定されていない
- **メッセージが届かない**
  - → Event Subscriptions で `message.im` / `app_mention` が登録されているか確認
- **`missing_scope` エラー**
  - → Bot Token Scopes に必要な権限が不足している。追加後に再インストール
