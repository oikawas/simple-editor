# Changelog

> This is a translation of [CHANGELOG.ja.md](CHANGELOG.ja.md). The Japanese version is authoritative.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Viewing and restoring edit history. The server records a version of the body and tags on every store (folding consecutive edits within 10 minutes into one), and "History" in the editor lists the versions, shows a diff against the current text or the full text, and restores any of them. A restore syncs to other devices, and the content from before it stays in the history
- `GET /api/notes/<id>/versions` and `GET /api/notes/<id>/versions/<version id>` APIs, and the `HISTORY_INTERVAL_MINUTES` environment variable
- Creating each note's first version on startup for databases created before history existed

- Full-text search over note bodies and tags: AND across multiple terms, case-insensitive, and substring matching for Japanese (including one- and two-character terms). Matches are highlighted in the list along with an excerpt of the body
- `GET /api/search` API
- Building the search index on startup for databases created before search existed
- `SPEC.ja.md` describing the specification and design principles, this changelog, and English versions of both
- English README (`README.md`); the Japanese version moved to `README.ja.md`

## [0.1.0] - 2026-10-21

### Added

- Initial implementation
- Server: WebSocket sync with Hocuspocus (Yjs), SQLite persistence, token authentication, note list API, `.txt` / `.zip` export
- Client: web app installable as a PWA (CodeMirror 6) with tags, trash, search (title, beginning of the body, tags), offline editing with IndexedDB, automatic merging of concurrent edits across devices, and other devices' cursors
- Docker image and compose file for a home server
- MIT license

[Unreleased]: https://github.com/oikawas/simple-editor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/oikawas/simple-editor/releases/tag/v0.1.0
