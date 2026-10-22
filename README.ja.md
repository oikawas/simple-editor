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
Caddyfile LAN 向けの HTTPS（ローカル CA）の設定。compose で Caddy が使う
```

クライアントは 1 つの PWA で、各プラットフォームでは次のようにインストールします。

| プラットフォーム | インストール方法 |
| --- | --- |
| macOS（Apple Silicon / Intel） | Safari でサーバーの URL を開き「ファイル → Dock に追加」、または Chrome の「アプリをインストール」 |
| iPhone | Safari で開き「共有 → ホーム画面に追加」 |
| Android | Chrome で開き「アプリをインストール」 |

> 接続先は `https://<サーバーの IP>/` です。PWA のインストールとオフライン動作には HTTPS が必要なため、事前に各端末へルート証明書をインストールします（後述）。

## ネットワークの前提

- サーバーには **同一 LAN 内の端末から** 接続します。インターネットには公開しません（ルーターのポート転送は設定しないでください）
- LAN の外から使う場合は、VPN などで LAN に入ってください。その設定と運用はこのアプリの範囲外です
- 通信は LAN 内でも HTTPS で暗号化します。証明書は同梱の Caddy が独自の認証局（ローカル CA）で発行するため、ドメインやインターネット上のサービスは不要です

## サーバーの起動（Ubuntu + Docker）

サーバーの IP アドレスは、ルーターの DHCP 予約などで固定しておいてください。IP が変わると、各端末では別のアプリとして扱われます。

```sh
git clone https://github.com/oikawas/simple-editor.git
cd simple-editor
cp .env.example .env
# .env を編集する
#   AUTH_TOKEN … openssl rand -hex 32 で作ったランダムな文字列
#   SERVER_IP  … サーバーの LAN の IP（例: 192.168.1.10）
docker compose up -d --build
```

- アプリのデータは `./data`、ローカル CA は `./caddy` に保存されます。バックアップは両方をコピーしてください。`./caddy` を失うと、全端末でルート証明書の入れ直しが必要になります
- `./caddy` には CA の秘密鍵が含まれます。外部に出さないでください

## 各端末の準備

### 1. ルート証明書をインストールする（端末ごとに初回のみ）

端末のブラウザで `http://<SERVER_IP>/ca.crt` を開いてダウンロードし、次の手順で信頼させます。

| 端末 | 手順 |
| --- | --- |
| iPhone | Safari で開いて「許可」→「設定 → 一般 → VPN とデバイス管理」でプロファイルをインストール →「設定 → 一般 → 情報 → 証明書信頼設定」でこの証明書を有効にする |
| macOS | ダウンロードしたファイルを開いてキーチェーンに追加 →「キーチェーンアクセス」でこの証明書を開き、「信頼」を「常に信頼」にする |
| Android | 「設定 → セキュリティ → 暗号化と認証情報 → 証明書のインストール → CA 証明書」でダウンロードしたファイルを選ぶ（メニュー名は機種により異なります） |

証明書は HTTP で配布されるため、インストールの前に、端末に表示される SHA-256 フィンガープリントをサーバー上の値と照合すると安全です。

```sh
openssl x509 -in caddy/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256
```

### 2. アプリを開く

`https://<SERVER_IP>/` を開き、設定画面で `.env` の `AUTH_TOKEN` を入力します。その後、上の表の方法で PWA としてインストールします。

## 設定（`.env`）

| 名前 | 既定値 | 説明 |
| --- | --- | --- |
| `AUTH_TOKEN` | （必須） | クライアントが使う共有トークン。16 文字以上 |
| `SERVER_IP` | （必須） | サーバーの LAN の IP。証明書の対象になり、接続先の URL にもなる |
| `SERVER_NAMES` | なし | LAN 内の DNS 名（空白区切り）。証明書の対象に加わる |
| `BIND_ADDRESS` | `0.0.0.0` | 待ち受けるホストのアドレス。LAN の IP を指定すると、そのインターフェイスだけで待ち受ける（Docker が公開するポートには ufw が効かないため） |
| `HTTP_PORT` | `80` | ルート証明書の配布と HTTPS への転送に使うポート |
| `HTTPS_PORT` | `443` | 443 以外にした場合、URL は `https://<SERVER_IP>:<ポート>/` になる |
| `HISTORY_INTERVAL_MINUTES` | `10` | この時間内の連続した編集を履歴の 1 つの版にまとめる |

compose を使わずにアプリを直接起動する場合は、ほかに `PORT`（既定 `8080`）、`DATA_DIR`、`STATIC_DIR` を指定できます。

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
