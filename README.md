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
- **Diary** — tabs switch between notes and the diary. Pick a date on the calendar to write that day's entry, one per day. Search covers notes and diary entries alike
- **Plain-text export** — export one note as `.txt`, or all notes as a `.zip` (one `.txt` per note, diary entries as `diary/year/month/date.txt`, plus `notes.json` with tags and dates)
- **Works offline** — notes are also stored in the device's IndexedDB and sync automatically on reconnect
- **Per-device registration** — each device receives its own token when it registers. A lost device can be revoked on its own from any other device. Addresses with repeated failed sign-ins are locked out for a while

## Layout

```
server/   Node.js + Hocuspocus (Yjs sync server) + SQLite. Also serves the web client
client/   Web client (TypeScript + CodeMirror 6), installable as a PWA
core/     Shared core for the native apps (Rust): sync, networking, on-device storage; used from Swift and Kotlin through UniFFI
linux/    The Linux app (Rust + GTK4 / libadwaita)
apple/    The macOS and iOS app (SwiftUI) and the core's Swift package
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

Open `http://<SERVER_IP>/ca.crt` in the device's browser to download it, then trust it as follows (`http://<SERVER_IP>:<HTTP_PORT>/ca.crt` if `HTTP_PORT` is not 80).

| Device | Steps |
| --- | --- |
| iPhone and iPad | See "On iPhone and iPad" below |
| macOS | Open the downloaded file to add it to the keychain → open the certificate in Keychain Access and set Trust to Always Trust |
| Android | Choose the downloaded file in Settings → Security → Encryption & credentials → Install a certificate → CA certificate (menu names vary by manufacturer) |

The certificate is served over plain HTTP, so before installing it, compare the SHA-256 fingerprint shown on the device with the value on the server:

```sh
openssl x509 -in caddy/caddy/pki/authorities/local/root.crt -noout -fingerprint -sha256
```

#### On iPhone and iPad

1. Open `http://<SERVER_IP>/ca.crt` in **Safari** (`http`, not `https`; other browsers cannot download it as a configuration profile). When it says the website is trying to download a configuration profile, tap Allow, then Close
2. Open Settings and tap "Profile Downloaded" near the top (or the profile under General → VPN & Device Management) → Install → passcode → Install → Done. It is shown as "Not Signed", which is expected for your own server's certificate. Under the profile's More Details → the certificate, you can compare the SHA-256 fingerprint with the value on the server
3. **In Settings → General → About → Certificate Trust Settings, turn on the switch for this certificate (Caddy Local Authority).** Installing it alone does not make it trusted, and HTTPS connections fail
4. Open `https://<SERVER_IP>/` in Safari; if it opens without a warning, you are done

Deleting the server's `./caddy` creates a new certificate. Then remove the old profile under General → VPN & Device Management and repeat these steps.

### 2. Open the app

Open `https://<SERVER_IP>/`, enter a device name and the registration token (`AUTH_TOKEN` in `.env`) in the settings dialog, and press Register. Then install it as a PWA as described in the table above.

- The registration token is used once to register and is not stored on the device. From then on the device uses a token issued to it
- The settings (⚙︎) list the registered devices; you can rename this device and revoke others. If a device is lost, revoke it from another device
- A web app set up before device tokens registers itself automatically the next time it opens

## Linux app (GTK4)

Besides the web app there is a native Linux app. It needs GTK 4.14 or later and libadwaita 1.5 or later (Ubuntu 24.04 or later, for example).

```sh
sudo apt install build-essential libgtk-4-dev libadwaita-1-dev   # plus Rust (rustup)
cargo build --release -p simple-editor-gtk
install -Dm755 target/release/simple-editor-gtk ~/.local/bin/simple-editor-gtk
install -Dm644 linux/data/io.github.oikawas.SimpleEditor.desktop ~/.local/share/applications/io.github.oikawas.SimpleEditor.desktop
```

- Install the server's root certificate into the OS certificate store (on Debian / Ubuntu):
  ```sh
  sudo cp simple-editor-ca.crt /usr/local/share/ca-certificates/
  sudo update-ca-certificates
  ```
- On first launch, enter the server URL (`https://<SERVER_IP>`), a device name, and the registration token in the settings to register
- The device token is kept in the desktop keyring (GNOME Keyring and the like, via Secret Service). Without one, it goes to `~/.config/simple-editor/device-token`, readable only by you
- Notes are also kept in `~/.local/share/simple-editor`, so they can be read and edited offline

## macOS and iOS app (SwiftUI)

Built on a Mac with Xcode. It runs on macOS 15 or later and iOS 18 or later.

Requirements: Xcode 16 or later, Rust (rustup, not Homebrew's Rust), and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`). To build for iPhone, download the iOS platform in Xcode under Settings… → Components.

### Preparing the build

```sh
./apple/build-xcframework.sh          # builds the Rust core for macOS and iOS (a few minutes the first time)
cd apple
DEVELOPMENT_TEAM=<team ID> xcodegen generate
open SimpleEditor.xcodeproj
```

- Your team ID is on the Membership page of your Apple Developer account. Without it, choose the Team under the target's Signing & Capabilities in Xcode
- `SimpleEditor.xcodeproj` is generated from `project.yml` and is not in the repository. When `project.yml` changes (after `git pull`, for example), quit Xcode and run `xcodegen generate` again
- Run `build-xcframework.sh` again after changing the core
- `apple/SimpleEditorCore/.swiftpm/`, created by Xcode, is per-user state and is not committed (it is in `.gitignore`)

### Running on a Mac

Choose the scheme **SimpleEditor-macOS** and the destination **My Mac** at the top center of the window, then Product → Run (⌘R).

### Running on an iPhone

1. Install and trust the server's root certificate on the iPhone ("On iPhone and iPad" above)
2. Connect the iPhone to the Mac with a USB cable and tap "Trust This Computer"
3. Turn on Settings → Privacy & Security → Developer Mode on the iPhone (and "Turn On" after it restarts). The item appears once the iPhone has been connected to Xcode
4. In Xcode, choose the scheme **SimpleEditor-iOS** and **your iPhone** as the destination, then press ⌘R. "Any iOS Device" only builds and does not install on the iPhone, and neither does ⌘B (Build)
5. If it does not open because of an "Untrusted Developer", trust your developer under Settings → General → VPN & Device Management on the iPhone and press ⌘R again
6. Allow access to the local network when asked on first launch. If you did not, turn on Simple Editor under Settings → Privacy & Security → Local Network
7. On the registration screen, enter the server URL (`https://<SERVER_IP>`; `https://` may be left out), a device name, and the registration token (`AUTH_TOKEN` in `.env`), then tap Register. Copying the token on the Mac lets you paste it on the iPhone through Universal Clipboard

- An app signed with a free Apple ID (Personal Team) stops opening after 7 days; run it from Xcode again to reinstall (one year with the Apple Developer Program)
- To try it in the simulator, drag `ca.crt` onto the simulator's screen and trust it with steps 2 and 3 of "On iPhone and iPad"
- If it says it cannot reach the server, check that `https://<SERVER_IP>/` opens in Safari without a warning (the certificate), the local network permission, and that the iPhone is on the same LAN's Wi-Fi

### Other notes

- The device token is kept in the Keychain. Notes are also kept in the app's data, so they can be read and edited offline
- The UI-independent part (`SimpleEditorModel` in `apple/SimpleEditorCore`) can be tested with `swift test` on a Mac or on Linux. With `SIMPLE_EDITOR_TEST_SERVER` (server URL) and `SIMPLE_EDITOR_TEST_TOKEN` (registration token) set, it drives two devices against a real server. On Linux, run `./apple/generate-bindings.sh` first

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

- An Android app
- Offline full-text search (offline, only the open note is searched by its full body; other notes by title, beginning, and tags)
- Emptying the trash, a retention period for history
- Importing from Simplenote

## License

[MIT](LICENSE)
