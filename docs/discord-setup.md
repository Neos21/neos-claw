# Discord Bot 設定手順


## 必要なトークン

| 変数            | 説明                                              |
|-----------------|---------------------------------------------------|
| `DISCORD_TOKEN` | Bot トークン。Discord Developer Portal で取得する |


## 手順

### 1. Discord Application を作成する

1. <https://discord.com/developers/applications> を開く
2. **New Application** をクリック
3. 名前 (例 : `Neo's Claw`) を入力して **Create**

### 2. Bot を作成してトークンを取得する

1. 左メニュー **Bot** を開く
2. **Add Bot** → **Yes, do it!** をクリック
3. **Token** セクションの **Reset Token** をクリック
4. 表示されたトークンをコピー → `.env` の `DISCORD_TOKEN` に貼る
    - ⚠️ トークンは一度しか表示されません。必ずすぐコピーしてください。

### 3. Privileged Gateway Intents を有効にする

同じ **Bot** ページで以下を **オン** にする。

| Intent                     | 用途                                                        |
|----------------------------|-------------------------------------------------------------|
| **Message Content Intent** | メッセージ本文を読む (**必須**。これがないと本文が空になる) |
| Server Members Intent      | 任意                                                        |

**Save Changes** をクリック。

### 4. Bot をサーバに招待する

1. 左メニュー **OAuth2 → URL Generator** を開く
2. **Scopes** で以下にチェックする
    - `bot`
    - `applications.commands`
3. **Bot Permissions** で以下にチェックする

| 権限                          | 用途                 |
|-------------------------------|----------------------|
| Read Messages / View Channels | メッセージを読む     |
| Send Messages                 | メッセージを送信する |
| Send Messages In Threads      | スレッドで返信する   |
| Read Message History          | 履歴を読む           |

4. ページ下部に生成された URL をブラウザで開く
5. 招待したいサーバを選択して **認証**

### 5. 動作確認

```bash
# .env を設定してから起動
$ DISCORD_ENABLED=true npm start
```

- DM でボットに話しかける (メンション不要)
- サーバのチャンネルでメンション (`@Neo's Claw こんにちは`)


## チャンネルモードの設定

デフォルトはサーバチャンネルでメンションが必要です。特定のチャンネルでメンションなしに反応させたい場合は、`adapters/discord.ts` の初期化時に設定します。

```ts
// 特定チャンネルで全メッセージに反応
new DiscordAdapter(core, {
  channelMode: 'all',
  allowedChannelIds: ['123456789012345678'],  // チャンネル ID
});
```

チャンネル ID は Discord でチャンネルを右クリック → **IDをコピー** で取得できます (開発者モードが必要)。

> 開発者モードの有効化 : **設定 → 詳細設定 → 開発者モード** をオン


## トラブルシューティング

- **メッセージ本文が空 / ボットが反応しない**
    - → **Message Content Intent** が有効になっているか確認 (最もよくあるミス)
- **`DISCORD_TOKEN Is Required` エラー**
    - → `.env` の `DISCORD_TOKEN` が未設定
- **ボットがオフラインのまま**
    - → トークンが正しいか確認。**Bot** ページで **Reset Token** して再取得
- **DM が届かない**
    - → `Partials.Channel` と `Partials.Message` が `discord.ts` に含まれているか確認 (デフォルトで含まれています)
