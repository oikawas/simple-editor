# Changelog

> This is a translation of [CHANGELOG.ja.md](CHANGELOG.ja.md). The Japanese version is authoritative.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Per-device tokens. `AUTH_TOKEN` now registers devices, and each registered device gets its own token (the server stores only a hash). The settings list registered devices and can rename this device or revoke any device; a revoked device is disconnected at once
- Limiting authentication attempts: an address with repeated failures is locked out for a while (`AUTH_MAX_FAILURES`, `AUTH_WINDOW_MINUTES`, `AUTH_LOCKOUT_MINUTES`)
- APIs: `POST /api/devices`, `GET /api/devices`, `PATCH /api/devices/current`, `DELETE /api/devices/<id>`
- A native macOS and iOS app (SwiftUI, `apple/`) with the same features as the Linux app; the device token is kept in the Keychain, and the settings choose the editor's typeface and size. The UI-independent part is the Swift package `SimpleEditorModel`, which can be tested on Linux too
- A native Linux app (GTK4 / libadwaita, `linux/`): list, search, tags, trash, editing, export, history and restore, device registration and management, and offline editing
- A shared core for the native apps (Rust, `core/`): Yjs-compatible sync, on-device storage, and the server API, usable from Swift and Kotlin through UniFFI

- HTTPS within the LAN. Compose adds Caddy, which issues certificates from its own local certificate authority (CA); each device trusts the root certificate downloaded from `http://<server>/ca.crt`. Connections by IP address (without SNI) are supported
- `.env` settings `SERVER_IP`, `SERVER_NAMES`, `BIND_ADDRESS`, `HTTP_PORT`, and `HTTPS_PORT`

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

### Changed

- `AUTH_TOKEN` no longer reads or writes notes. An existing web app registers itself with its stored `AUTH_TOKEN` the next time it opens and switches to a device token
- A web app whose token is refused stops reconnecting and asks to be registered again
- The premise is now that devices connect to the server from the same LAN. Reaching it from outside (a VPN or similar) is out of scope, and the README's instructions for exposing it through Tailscale or a reverse proxy were removed
- The app container no longer publishes a host port; it is reachable only through Caddy

### Fixed

- Starting compose without an existing `./data` failed because Docker created the directory as root and the app could not write to it. The container now fixes the ownership on startup, then drops to a non-root user
- Compose did not pass `HISTORY_INTERVAL_MINUTES` to the app

[Unreleased]: https://github.com/oikawas/simple-editor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/oikawas/simple-editor/releases/tag/v0.1.0
