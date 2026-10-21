# 変更履歴

> この文書が正本です。英語版 [CHANGELOG.md](CHANGELOG.md) はこの文書の翻訳です。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に従い、バージョン番号は [セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

## [未リリース]

### 追加

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

[未リリース]: https://github.com/oikawas/simple-editor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/oikawas/simple-editor/releases/tag/v0.1.0
