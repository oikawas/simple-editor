# Simple Editor

[English](README.md) | 日本語

> この文書が正本です。英語版 [README.md](README.md) はこの文書の翻訳です。

Simplenote の代わりに使える、自宅サーバーで動かすプレーンテキストのメモアプリです。

詳しい仕様と設計方針は [SPEC.ja.md](SPEC.ja.md)、変更履歴は [CHANGELOG.ja.md](CHANGELOG.ja.md) を参照してください。

- **タグ** — ノートに複数のタグを付け、タグで絞り込めます
- **複数端末から安全に同時編集** — [Yjs](https://yjs.dev/)（CRDT）で編集を同期します。同じノートを複数の端末で同時に編集しても、オフライン中に編集しても、変更が失われずにマージされます
- **作成日の保持** — 作成日時はノートに記録され、サーバー側でも最初に保存された値を上書きしません
- **全文検索** — 本文とタグを対象に検索できます。空白で区切った語はすべて含むノートに絞り込み（AND）、大文字・小文字は区別しません。日本語も単語分割なしで部分一致します
- **編集履歴** — 過去の版を一覧し、現在との差分を確認して、任意の版に戻せます。戻す前の内容も履歴に残ります
- **テキスト書き出し** — 1件ずつ `.txt` で、または全件を `.zip`（各ノートの `.txt` と、タグや日付を収めた `notes.json`）で書き出せます
- **オフライン対応** — ノートは端末の IndexedDB にも保存され、再接続時に自動で同期します

## 構成

```
server/   Node.js + Hocuspocus（Yjs の同期サーバー）+ SQLite。Web クライアントも配信する
client/   Web クライアント（TypeScript + CodeMirror 6）。PWA としてインストールできる
```

クライアントは 1 つの PWA で、各プラットフォームでは次のようにインストールします。

| プラットフォーム | インストール方法 |
| --- | --- |
| macOS（Apple Silicon / Intel） | Safari でサーバーの URL を開き「ファイル → Dock に追加」、または Chrome の「アプリをインストール」 |
| iPhone | Safari で開き「共有 → ホーム画面に追加」 |
| Android | Chrome で開き「アプリをインストール」 |

> PWA のインストールとオフライン動作には **HTTPS** が必要です（後述）。

## サーバーの起動（Ubuntu + Docker）

```sh
git clone https://github.com/oikawas/simple-editor.git
cd simple-editor
echo "AUTH_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

- データは `./data/notes.db`（SQLite）に保存されます。バックアップはこのファイルをコピーしてください
- 初期設定ではホストの `127.0.0.1:8080` のみで待ち受けます。端末からは下記の HTTPS 経由で接続してください
- 初回アクセス時に設定画面が開くので、`.env` の `AUTH_TOKEN` を入力します

### HTTPS で公開する

どちらか一方で十分です。

**Tailscale（おすすめ・ポート開放不要）** — サーバーと各端末を同じ tailnet に入れ、サーバーで次を実行します。

```sh
sudo tailscale serve --bg 8080
# → https://<マシン名>.<tailnet>.ts.net で全端末からアクセスできる
```

**Caddy などのリバースプロキシ** — 独自ドメインで公開する場合の例です。WebSocket（`/sync`）もそのまま転送されます。

```
notes.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

### 環境変数

| 名前 | 既定値 | 説明 |
| --- | --- | --- |
| `AUTH_TOKEN` | （必須） | クライアントが使う共有トークン。16 文字以上 |
| `PORT` | `8080` | 待ち受けポート |
| `DATA_DIR` | `/data` | SQLite の保存先 |
| `HISTORY_INTERVAL_MINUTES` | `10` | この時間内の連続した編集を履歴の 1 つの版にまとめる |
| `STATIC_DIR` | `/app/client/dist` | 配信する Web クライアント |

## API

`Authorization: Bearer <AUTH_TOKEN>` が必要です（`/api/health` を除く）。

| パス | 内容 |
| --- | --- |
| `GET /api/health` | 死活確認 |
| `GET /api/notes` | ノート一覧（タイトル、タグ、作成日、更新日、ゴミ箱フラグ） |
| `GET /api/search?q=...` | 全文検索。一致したノートの ID と抜粋を更新日の新しい順に返す |
| `GET /api/notes/:id/versions` | 編集履歴の版の一覧 |
| `GET /api/notes/:id/versions/:versionId` | 1 つの版の本文とタグ |
| `GET /api/notes/:id.txt` | 1 件をテキストで取得 |
| `GET /api/export.zip` | 全件を zip で取得（`?trash=1` でゴミ箱も含める） |
| `WS /sync` | Yjs の同期（Hocuspocus プロトコル） |

## 開発

```sh
npm install
AUTH_TOKEN=dev-token-0123456789 npm run dev:server   # :8080
npm run dev:client                                   # :5173（/api と /sync を :8080 へ転送）
npm test                                             # サーバーの統合テスト
```

データモデルや同期の流れなど、設計の詳細は [SPEC.ja.md](SPEC.ja.md) を参照してください。

## 今後の候補

- ネイティブアプリ化（PWA を Tauri / Capacitor で包む）
- オフライン時の全文検索（現状、オフライン中に本文まで検索できるのは開いているノートだけで、他はタイトル・冒頭・タグが対象）
- ゴミ箱を空にする操作、履歴の保存期間の設定
- Simplenote からのインポート

## ライセンス

[MIT](LICENSE)
