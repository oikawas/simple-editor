# 変更履歴

> この文書が正本です。英語版 [CHANGELOG.md](CHANGELOG.md) はこの文書の翻訳です。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に従い、バージョン番号は [セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

## [未リリース]

### 追加

- 端末ごとのトークン。`AUTH_TOKEN` は端末の登録用になり、登録した端末にはそれぞれ専用のトークンを発行する（サーバーはハッシュだけを保存）。設定画面で登録済みの端末の一覧、端末名の変更、登録解除ができる。解除した端末の接続はその場で切る
- 認証の試行回数の制限。失敗が続いた接続元を一定時間締め出す（`AUTH_MAX_FAILURES`、`AUTH_WINDOW_MINUTES`、`AUTH_LOCKOUT_MINUTES`）
- API: `POST /api/devices`、`GET /api/devices`、`PATCH /api/devices/current`、`DELETE /api/devices/<id>`
- Linux 版のネイティブアプリ（GTK4 / libadwaita、`linux/`）。一覧・検索・タグ・ゴミ箱・編集・書き出し・編集履歴と復元、端末の登録と管理、オフライン編集に対応
- ネイティブアプリ共通のコア（Rust、`core/`）。Yjs 互換の同期、端末内の保存、サーバーの API を、UniFFI で Swift・Kotlin から使えるようにする

- LAN 内での HTTPS 接続。compose に Caddy を加え、独自の認証局（ローカル CA）で証明書を発行する。各端末は `http://<サーバー>/ca.crt` からルート証明書を入れて信頼させる。IP アドレスでの接続（SNI なし）にも対応
- `.env` の設定項目 `SERVER_IP`、`SERVER_NAMES`、`BIND_ADDRESS`、`HTTP_PORT`、`HTTPS_PORT`

- 編集履歴の閲覧と復元。サーバーが保存のたびに本文とタグの版を記録し（10 分以内の連続編集は 1 つにまとめる）、エディタの「履歴」から版の一覧、現在との差分、全文を表示して、任意の版に戻せる。復元は他の端末にも同期され、復元前の内容も履歴に残る
- `GET /api/notes/<id>/versions` と `GET /api/notes/<id>/versions/<版 ID>` API、環境変数 `HISTORY_INTERVAL_MINUTES`
- 履歴機能より前に作られたデータベースに対し、起動時に各ノートの最初の版を作成する処理

- 本文とタグを対象にした全文検索。複数語の AND 検索、大文字・小文字の区別なし、日本語の部分一致（1〜2 文字の語を含む）に対応。一覧で一致箇所を強調表示し、本文の抜粋を表示する
- `GET /api/search` API
- 検索機能より前に作られたデータベースに対し、起動時に検索索引を作成する処理
- 仕様と設計方針をまとめた `SPEC.ja.md`、この変更履歴、それぞれの英語版
- 英語版の README（`README.md`）。日本語版は `README.ja.md` に移動

## [0.1.0] - 2026-10-21

### 追加

- 最初の実装
- サーバー: Hocuspocus（Yjs）による WebSocket 同期、SQLite への保存、トークン認証、ノート一覧 API、`.txt` / `.zip` の書き出し
- クライアント: PWA としてインストールできる Web アプリ（CodeMirror 6）。タグ、ゴミ箱、検索（タイトル・冒頭・タグ）、IndexedDB によるオフライン編集、複数端末の同時編集の自動マージ、他の端末のカーソル表示
- 自宅サーバー向けの Docker イメージと compose ファイル
- MIT ライセンス

### 変更

- `AUTH_TOKEN` ではノートを読み書きできなくなった。既存の Web アプリは、次に開いたときに保存済みの `AUTH_TOKEN` で自動的に端末登録し、端末トークンに置き換える
- トークンが拒否された Web アプリは、再接続を繰り返さずに登録し直すよう案内する
- 前提を「サーバーには同一 LAN 内の端末から接続する」に改めた。LAN の外からの経路（VPN など）は範囲外とし、README の Tailscale とリバースプロキシによる公開手順を削除した
- アプリのコンテナはホストのポートに公開せず、Caddy からだけ届くようにした

### 修正

- Web アプリをダークモードで使うと、エディタの入力位置の縦棒と選択範囲が背景に溶けて見えなかった問題

- `./data` がない状態で compose を起動すると、Docker が root 所有で作成したディレクトリにアプリが書き込めず起動に失敗する問題。起動時に所有者を整えてから root 以外のユーザーに権限を落とすようにした
- compose で `HISTORY_INTERVAL_MINUTES` がアプリに渡されていなかった問題

[未リリース]: https://github.com/oikawas/simple-editor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/oikawas/simple-editor/releases/tag/v0.1.0
