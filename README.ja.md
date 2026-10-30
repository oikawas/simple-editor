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
- **端末ごとの登録** — 各端末は登録時に専用のトークンを受け取ります。なくした端末は、ほかの端末からその端末だけ登録を解除できます。認証の失敗が続く接続元は一時的に締め出します

## 構成

```
server/   Node.js + Hocuspocus（Yjs の同期サーバー）+ SQLite。Web クライアントも配信する
client/   Web クライアント（TypeScript + CodeMirror 6）。PWA としてインストールできる
core/     ネイティブアプリ共通のコア（Rust）。同期・通信・端末内の保存。UniFFI で Swift・Kotlin から使う
linux/    Linux 版（Rust + GTK4 / libadwaita）
apple/    macOS・iOS 版（SwiftUI）と、コアの Swift パッケージ
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
#   AUTH_TOKEN … 端末の登録用トークン。openssl rand -hex 32 で作ったランダムな文字列
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

`https://<SERVER_IP>/` を開き、設定画面で端末名と登録用トークン（`.env` の `AUTH_TOKEN`）を入力して「登録」を押します。その後、上の表の方法で PWA としてインストールします。

- 登録用トークンは登録のときに一度だけ使い、端末には保存しません。以後は端末ごとに発行されたトークンで通信します
- 設定画面（⚙︎）に登録済みの端末が並び、端末名の変更や、ほかの端末の登録解除ができます。端末をなくしたときは、別の端末からその端末の登録を解除してください
- 端末トークンを導入する前から使っていた Web アプリは、次に開いたときに自動で登録し直します

## Linux 版（GTK4）

Web アプリのほかに、Linux 用のネイティブアプリがあります。GTK 4.14 以上と libadwaita 1.5 以上（Ubuntu 24.04 以降など）が必要です。

```sh
sudo apt install build-essential libgtk-4-dev libadwaita-1-dev   # Rust（rustup）も必要
cargo build --release -p simple-editor-gtk
install -Dm755 target/release/simple-editor-gtk ~/.local/bin/simple-editor-gtk
install -Dm644 linux/data/io.github.oikawas.SimpleEditor.desktop ~/.local/share/applications/io.github.oikawas.SimpleEditor.desktop
```

- サーバーのルート証明書は、OS の証明書ストアに入れます（Debian / Ubuntu の場合）
  ```sh
  sudo cp simple-editor-ca.crt /usr/local/share/ca-certificates/
  sudo update-ca-certificates
  ```
- 初回起動時の設定画面で、サーバー URL（`https://<SERVER_IP>`）、端末名、登録用トークンを入力して登録します
- 端末トークンはデスクトップの鍵束（GNOME Keyring など、Secret Service）に保存します。鍵束がない環境では `~/.config/simple-editor/device-token`（本人だけが読める権限）に保存します
- ノートは `~/.local/share/simple-editor` にも保存され、オフラインでも読み書きできます

## macOS・iOS 版（SwiftUI）

Mac で Xcode を使ってビルドします。macOS 15 以上、iOS 18 以上で動きます。

必要なもの: Xcode 16 以上、Rust（rustup）、[XcodeGen](https://github.com/yonaskolb/XcodeGen)（`brew install xcodegen`）

```sh
./apple/build-xcframework.sh          # Rust のコアを macOS・iOS 向けにビルドする（初回は数分かかる）
cd apple
DEVELOPMENT_TEAM=<チーム ID> xcodegen generate
open SimpleEditor.xcodeproj           # SimpleEditor-macOS か SimpleEditor-iOS を選んで実行
```

- チーム ID は Apple Developer のアカウントページ（Membership）で確認できます。指定しなかった場合は、Xcode の Signing & Capabilities で選んでください
- コアを変更したら `build-xcframework.sh` を実行し直します
- iPhone では、事前にサーバーのルート証明書をインストールしておきます（上の「各端末の準備」）。初回起動時に、ローカルネットワークへの接続の許可を求められるので許可してください
- 端末トークンはキーチェーンに保存します。ノートはアプリのデータ領域にも保存され、オフラインでも読み書きできます
- 画面に依存しない部分（`apple/SimpleEditorCore` の `SimpleEditorModel`）は、Mac でも Linux でも `swift test` でテストできます。`SIMPLE_EDITOR_TEST_SERVER`（サーバー URL）と `SIMPLE_EDITOR_TEST_TOKEN`（登録用トークン）を設定すると、実際のサーバーを相手に 2 台分の操作を確認します。Linux では先に `./apple/generate-bindings.sh` を実行します

## 設定（`.env`）

| 名前 | 既定値 | 説明 |
| --- | --- | --- |
| `AUTH_TOKEN` | （必須） | 端末の登録用トークン。16 文字以上。これではノートを読めない。漏れたら変更する（登録済みの端末はそのまま使える） |
| `SERVER_IP` | （必須） | サーバーの LAN の IP。証明書の対象になり、接続先の URL にもなる |
| `SERVER_NAMES` | なし | LAN 内の DNS 名（空白区切り）。証明書の対象に加わる |
| `BIND_ADDRESS` | `0.0.0.0` | 待ち受けるホストのアドレス。LAN の IP を指定すると、そのインターフェイスだけで待ち受ける（Docker が公開するポートには ufw が効かないため） |
| `HTTP_PORT` | `80` | ルート証明書の配布と HTTPS への転送に使うポート |
| `HTTPS_PORT` | `443` | 443 以外にした場合、URL は `https://<SERVER_IP>:<ポート>/` になる |
| `HISTORY_INTERVAL_MINUTES` | `10` | この時間内の連続した編集を履歴の 1 つの版にまとめる |
| `AUTH_MAX_FAILURES` | `10` | 認証の失敗がこの回数に達した接続元を締め出す |
| `AUTH_WINDOW_MINUTES` | `15` | 失敗を数える期間 |
| `AUTH_LOCKOUT_MINUTES` | `15` | 締め出す時間。この間は正しいトークンも受け付けない |

compose を使わずにアプリを直接起動する場合は、ほかに `PORT`（既定 `8080`）、`DATA_DIR`、`STATIC_DIR` を指定できます。

## API

`Authorization: Bearer <端末トークン>` が必要です（`/api/health` と端末の登録を除く）。

| パス | 内容 |
| --- | --- |
| `GET /api/health` | 死活確認 |
| `POST /api/devices` | 端末の登録（登録用トークンが必要）。端末トークンを返す |
| `GET /api/devices` | 登録済みの端末の一覧 |
| `PATCH /api/devices/current` | この端末の名前を変える |
| `DELETE /api/devices/:id` | 端末の登録を解除する |
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
npm run build -w server && (cd core && cargo test)   # コアのテスト（実際のサーバーを起動して確認する）
```

データモデルや同期の流れなど、設計の詳細は [SPEC.ja.md](SPEC.ja.md) を参照してください。

## 今後の候補

- Android 版
- オフライン時の全文検索（現状、オフライン中に本文まで検索できるのは開いているノートだけで、他はタイトル・冒頭・タグが対象）
- ゴミ箱を空にする操作、履歴の保存期間の設定
- Simplenote からのインポート

## ライセンス

[MIT](LICENSE)
