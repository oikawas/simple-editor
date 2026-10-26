# Simple Editor

English | [日本語](README.ja.md)

> This is a translation of [README.ja.md](README.ja.md). The Japanese version is authoritative.

## Introduction

Simple Editor is a plain-text notes app you host yourself, written as a replacement for Simplenote.

It runs on a home server with Docker Compose, stores everything in a single SQLite file, and is reached from devices on the same LAN over HTTPS, using certificates from a local certificate authority, so no domain or internet service is needed. The client is one web app that you install as a PWA on macOS, iPhone, and Android. Notes sync live between devices through [Yjs](https://yjs.dev/), a CRDT, so you can edit the same note on several devices at once, or offline, and no change is lost. Each device also keeps its own copy of the notes and sends offline edits when it reconnects. Full-text search and an edit history you can restore from are built in.

See [SPEC.md](SPEC.md) for the full specification and design principles, and [CHANGELOG.md](CHANGELOG.md) for the history of changes.

## Features

- **Tags** — add several tags to a note and filter the list by tag
- **Safe concurrent editing from several devices** — edits sync through Yjs. Whether you edit the same note on several devices at once or while offline, changes are merged without losing any of them
- **Creation dates are kept** — the creation time is recorded in the note, and the server never overwrites the first value it stored
- **Full-text search** — search note bodies and tags. Whitespace-separated terms must all match (AND), case is ignored, and Japanese matches by substring without word segmentation
- **Edit history** — list past versions, compare them with the current text, and restore any of them. The content from before a restore stays in the history
- **Plain-text export** — export one note as `.txt`, or all notes as a `.zip` (one `.txt` per note plus `notes.json` with tags and dates)
- **Works offline** — notes are also stored in the device's IndexedDB and sync automatically on reconnect
- **Per-device registration** — each device receives its own token when it registers. A lost device can be revoked on its own from any other device. Addresses with repeated failed sign-ins are locked out for a while

## Layout

```
server/   Node.js + Hocuspocus (Yjs sync server) + SQLite. Also serves the web client
client/   Web client (TypeScript + CodeMirror 6), installable as a PWA
core/     Shared core for the native apps (Rust): sync, networking, on-device storage; used from Swift and Kotlin through UniFFI
Caddyfile HTTPS on the LAN (local CA), used by Caddy in compose
```

The client is a single PWA. Install it on each platform as follows.

| Platform | How to install |
| --- | --- |
| macOS (Apple Silicon / Intel) | Open the server URL in Safari and choose File → Add to Dock, or use "Install app" in Chrome |
| iPhone | Open it in Safari and choose Share → Add to Home Screen |
| Android | Open it in Chrome and choose "Install app" |

> The app lives at `https://<server IP>/`. Installing the PWA and using it offline require HTTPS, so each device first installs a root certificate (see below).

## Network assumptions

- Devices connect to the server **from the same LAN**. The server is not exposed to the internet (do not set up port forwarding on the router)
- To use it from outside, join the LAN through a VPN or similar; setting that up and running it is outside the scope of this app
- Traffic is encrypted with HTTPS even within the LAN. The bundled Caddy issues certificates from its own local certificate authority (CA), so no domain or internet service is needed

## Running the server (Ubuntu + Docker)

Give the server a fixed IP address, for example with a DHCP reservation on the router. If the IP changes, devices treat the app as a different one.

```sh
git clone https://github.com/oikawas/simple-editor.git
cd simple-editor
cp .env.example .env
# Edit .env:
#   AUTH_TOKEN … the device registration token, a random string, e.g. from openssl rand -hex 32
#   SERVER_IP  … the server's LAN IP (e.g. 192.168.1.10)
docker compose up -d --build
```

- App data is stored in `./data` and the local CA in `./caddy`. Back up both. Losing `./caddy` means reinstalling the root certificate on every device
- `./caddy` contains the CA's private key; keep it on the server

## Preparing each device

### 1. Install the root certificate (once per device)

Open `http://<SERVER_IP>/ca.crt` in the device's browser to download it, then trust it as follows.

| Device | Steps |
| --- | --- |
| iPhone | Open it in Safari and tap Allow → install the profile in Settings → General → VPN & Device Management → turn on trust for it in Settings → General → About → Certificate Trust Settings |
| macOS | Open the downloaded file to add it to the keychain → open the certificate in Keychain Access and set Trust to Always Trust |
| Android | Choose the downloaded file in Settings → Security → Encryption & credentials → Install a certificate → CA certificate (menu names vary by manufacturer) |

The certificate is served over plain HTTP, so before installing it, compare the SHA-256 fingerprint shown on the device with the value on the server:

```sh
openssl x509 -in caddy/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256
```

### 2. Open the app

Open `https://<SERVER_IP>/`, enter a device name and the registration token (`AUTH_TOKEN` in `.env`) in the settings dialog, and press Register. Then install it as a PWA as described in the table above.

- The registration token is used once to register and is not stored on the device. From then on the device uses a token issued to it
- The settings (⚙︎) list the registered devices; you can rename this device and revoke others. If a device is lost, revoke it from another device
- A web app set up before device tokens registers itself automatically the next time it opens

## Settings (`.env`)

| Name | Default | Description |
| --- | --- | --- |
| `AUTH_TOKEN` | (required) | Device registration token, at least 16 characters. It cannot read notes. Change it if it leaks (registered devices keep working) |
| `SERVER_IP` | (required) | The server's LAN IP. Covered by the certificate and used in the app's URL |
| `SERVER_NAMES` | none | DNS names on the LAN (space-separated), added to the certificate |
| `BIND_ADDRESS` | `0.0.0.0` | Host address to listen on. Set it to the LAN IP to listen on that interface only (ufw does not apply to ports Docker publishes) |
| `HTTP_PORT` | `80` | Port for the certificate download and the redirect to HTTPS |
| `HTTPS_PORT` | `443` | With a port other than 443, the URL becomes `https://<SERVER_IP>:<port>/` |
| `HISTORY_INTERVAL_MINUTES` | `10` | Consecutive edits within this time are folded into one history version |
| `AUTH_MAX_FAILURES` | `10` | Failed sign-ins after which an address is locked out |
| `AUTH_WINDOW_MINUTES` | `15` | Period over which failures are counted |
| `AUTH_LOCKOUT_MINUTES` | `15` | Lockout length; valid tokens are refused meanwhile too |

When running the app directly without compose, `PORT` (default `8080`), `DATA_DIR`, and `STATIC_DIR` can also be set.

## API

`Authorization: Bearer <device token>` is required (except for `/api/health` and device registration).

| Path | Description |
| --- | --- |
| `GET /api/health` | Health check |
| `POST /api/devices` | Registers a device (requires the registration token) and returns its device token |
| `GET /api/devices` | Registered devices |
| `PATCH /api/devices/current` | Renames this device |
| `DELETE /api/devices/:id` | Revokes a device |
| `GET /api/notes` | Note list (title, tags, creation date, update date, trash flag) |
| `GET /api/search?q=...` | Full-text search. Returns IDs and excerpts of matching notes, newest first |
| `GET /api/notes/:id/versions` | The note's history versions |
| `GET /api/notes/:id/versions/:versionId` | One version's body and tags |
| `GET /api/notes/:id.txt` | One note as text |
| `GET /api/export.zip` | All notes as a zip (`?trash=1` includes the trash) |
| `WS /sync` | Yjs sync (Hocuspocus protocol) |

## Development

```sh
npm install
AUTH_TOKEN=dev-token-0123456789 npm run dev:server   # :8080
npm run dev:client                                   # :5173 (forwards /api and /sync to :8080)
npm test                                             # server integration tests
npm run build -w server && (cd core && cargo test)   # core tests (they start the real server)
```

See [SPEC.md](SPEC.md) for design details such as the data model and sync flow.

## Possible next steps

- Native apps (UIs on the shared core: GTK4 for Linux, then SwiftUI for macOS and iOS, then Android)
- Offline full-text search (offline, only the open note is searched by its full body; other notes by title, beginning, and tags)
- Emptying the trash, a retention period for history
- Importing from Simplenote

## License

[MIT](LICENSE)
