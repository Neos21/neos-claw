# Brave Search API 設定手順


## 無料枠

| プラン | 月間クエリ数     | 料金                        |
|--------|------------------|-----------------------------|
| Free   | **2,000 クエリ** | 無料 (クレジットカード不要) |
| Base   | 2,000 超         | $3 / 1,000 クエリ           |

個人用途・開発用途なら無料枠で十分です。


## 手順

### 1. Brave Search API に登録する

1. <https://brave.com/search/api/> を開く
2. **Get started for FREE** をクリック
3. メールアドレスでアカウントを作成 (または既存アカウントでログイン)

### 2. API キーを発行する

1. ダッシュボード <https://api.search.brave.com/app/keys> を開く
2. **New Key** をクリック
3. Key Name（例: `neos-claw`）を入力して **Create**
4. 表示された API キーをコピー → `.env` の `BRAVE_API_KEY` に貼る

> ⚠️ キーはダッシュボードからいつでも確認できますが、安全のため `.env` 以外には貼らないでください。

### 3. mcp-config.json に設定する

`mcp-config.json` の `brave-search` エントリーがすでに設定済みです。`.env` に `BRAVE_API_KEY` を追加するだけで有効になります。

```
BRAVE_API_KEY=BSA...(取得したキー)
```

起動時のログに `brave_web_search` が表示されれば成功です。

```
✅ MCP Tools: ..., brave_web_search, ...
```

### 4. 使用量を確認する

ダッシュボード <https://api.search.brave.com/app/usage> で月間クエリ数を確認できます。


## Brave Search を使わない場合

API キーなしでも動作します。`mcp-config.json` から `brave-search` エントリーを削除するか、`.env` の `BRAVE_API_KEY` を空のままにしてください。

Web 検索が不要な用途 (ファイル操作・メモリ管理など) では Brave Search なしで問題ありません。


## トラブルシューティング

- **起動時に `BRAVE_API_KEY Environment Variable Is Required` エラー**
  - → `.env` に `BRAVE_API_KEY=` が設定されていない。キーを設定するか、`mcp-config.json` から `brave-search` エントリーを削除する
- **検索結果が返ってこない**
  - → 月間 2,000 クエリの無料枠を超えている可能性がある。ダッシュボードで使用量を確認
- **`401 Unauthorized`**
  → API キーが正しくコピーされていない。ダッシュボードで再確認
