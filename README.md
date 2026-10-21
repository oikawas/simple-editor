# Simple Editor

English | [日本語](README.ja.md)

> This is a translation of [README.ja.md](README.ja.md). The Japanese version is authoritative.

## Introduction

Simple Editor is a plain-text notes app you host yourself, written as a replacement for Simplenote.

It runs as one Docker container on a home server and stores everything in a single SQLite file. The client is one web app that you install as a PWA on macOS, iPhone, and Android. Notes sync live between devices through [Yjs](https://yjs.dev/), a CRDT, so you can edit the same note on several devices at once, or offline, and no change is lost. Each device also keeps its own copy of the notes and sends offline edits when it reconnects.

See [SPEC.md](SPEC.md) for the full specification and design principles, and [CHANGELOG.md](CHANGELOG.md) for the history of changes.

## Features

- **Tags** — add several tags to a note and filter the list by tag
- **Safe concurrent editing from several devices** — edits sync through Yjs. Whether you edit the same note on several devices at once or while offline, changes are merged without losing any of them
- **Creation dates are kept** — the creation time is recorded in the note, and the server never overwrites the first value it stored
- **Full-text search** — search note bodies and tags. Whitespace-separated terms must all match (AND), case is ignored, and Japanese matches by substring without word segmentation
- **Plain-text export** — export one note as `.txt`, or all notes as a `.zip` (one `.txt` per note plus `notes.json` with tags and dates)
- **Works offline** — notes are also stored in the device's IndexedDB and sync automatically on reconnect

## Layout

```
server/   Node.js + Hocuspocus (Yjs sync server) + SQLite. Also serves the web client
client/   Web client (TypeScript + CodeMirror 6), installable as a PWA
```

The client is a single PWA. Install it on each platform as follows.

| Platform | How to install |
| --- | --- |
| macOS (Apple Silicon / Intel) | Open the server URL in Safari and choose File → Add to Dock, or use "Install app" in Chrome |
| iPhone | Open it in Safari and choose Share → Add to Home Screen |
| Android | Open it in Chrome and choose "Install app" |

> Installing the PWA and using it offline require **HTTPS** (see below).

## Running the server (Ubuntu + Docker)

```sh
git clone https://github.com/oikawas/simple-editor.git
cd simple-editor
echo "AUTH_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

- Data is stored in `./data/notes.db` (SQLite). To back up, copy this file
- By default the server listens on the host's `127.0.0.1:8080` only. Connect from your devices over HTTPS as described below
- The settings dialog opens on first visit; enter the `AUTH_TOKEN` from `.env`

### Serving over HTTPS

Either one is enough.

**Tailscale (recommended, no port forwarding)** — put the server and your devices on the same tailnet and run this on the server:

```sh
sudo tailscale serve --bg 8080
# → reachable from every device at https://<machine-name>.<tailnet>.ts.net
```

**A reverse proxy such as Caddy** — an example for your own domain. WebSocket traffic (`/sync`) is forwarded as is.

```
notes.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

### Environment variables

| Name | Default | Description |
| --- | --- | --- |
| `AUTH_TOKEN` | (required) | Shared token used by clients. At least 16 characters |
| `PORT` | `8080` | Port to listen on |
| `DATA_DIR` | `/data` | Where the SQLite database is stored |
| `STATIC_DIR` | `/app/client/dist` | Web client to serve |

## API

`Authorization: Bearer <AUTH_TOKEN>` is required (except for `/api/health`).

| Path | Description |
| --- | --- |
| `GET /api/health` | Health check |
| `GET /api/notes` | Note list (title, tags, creation date, update date, trash flag) |
| `GET /api/search?q=...` | Full-text search. Returns IDs and excerpts of matching notes, newest first |
| `GET /api/notes/:id.txt` | One note as text |
| `GET /api/export.zip` | All notes as a zip (`?trash=1` includes the trash) |
| `WS /sync` | Yjs sync (Hocuspocus protocol) |

## Development

```sh
npm install
AUTH_TOKEN=dev-token-0123456789 npm run dev:server   # :8080
npm run dev:client                                   # :5173 (forwards /api and /sync to :8080)
npm test                                             # server integration tests
```

See [SPEC.md](SPEC.md) for design details such as the data model and sync flow.

## Possible next steps

- Native apps (wrapping the PWA with Tauri / Capacitor)
- Offline full-text search (offline, only the open note is searched by its full body; other notes by title, beginning, and tags)
- Browsing and restoring history, emptying the trash
- Importing from Simplenote

## License

[MIT](LICENSE)
