//! Runs the core against the real server (server/dist, built with
//! `npm run build -w server`) and against a JavaScript Yjs client.

use simple_editor_core::client::{register_device, Client, ClientConfig, ClientListener};
use simple_editor_core::error::CoreError;
use simple_editor_core::sync::SyncStatus;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const REGISTRATION_TOKEN: &str = "core-test-token-0123456789";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_owned()
}

struct Server {
    child: Option<Child>,
    port: u16,
    data: tempfile::TempDir,
}

impl Server {
    fn start() -> Server {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let mut server = Server { child: None, port, data: tempfile::tempdir().unwrap() };
        server.restart();
        server
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn restart(&mut self) {
        let child = Command::new("node")
            .arg(repo_root().join("server/dist/index.js"))
            .env("AUTH_TOKEN", REGISTRATION_TOKEN)
            .env("DATA_DIR", self.data.path())
            .env("PORT", self.port.to_string())
            .env("HISTORY_INTERVAL_MINUTES", "0")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("node");
        self.child = Some(child);
        let deadline = Instant::now() + Duration::from_secs(10);
        while std::net::TcpStream::connect(("127.0.0.1", self.port)).is_err() {
            assert!(Instant::now() < deadline, "server did not start");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Default)]
struct Recorder {
    statuses: Mutex<Vec<SyncStatus>>,
    notes_changed: AtomicUsize,
    note_changed: Mutex<Vec<String>>,
}

impl Recorder {
    fn last_status(&self) -> Option<SyncStatus> {
        self.statuses.lock().unwrap().last().copied()
    }
}

impl ClientListener for Recorder {
    fn on_status(&self, status: SyncStatus) {
        self.statuses.lock().unwrap().push(status);
    }
    fn on_notes_changed(&self) {
        self.notes_changed.fetch_add(1, Ordering::SeqCst);
    }
    fn on_note_changed(&self, id: String) {
        self.note_changed.lock().unwrap().push(id);
    }
}

async fn until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

struct Device {
    client: Arc<Client>,
    events: Arc<Recorder>,
    token: String,
    id: String,
    _data: tempfile::TempDir,
}

async fn device(server: &Server, name: &str) -> Device {
    let creds = register_device(server.url(), REGISTRATION_TOKEN.into(), name.into()).await.unwrap();
    let data = tempfile::tempdir().unwrap();
    let events = Arc::new(Recorder::default());
    let client = Client::new(
        ClientConfig {
            server_url: server.url(),
            device_token: creds.token.clone(),
            data_dir: data.path().to_string_lossy().into(),
        },
        events.clone(),
    )
    .unwrap();
    until("online", || events.last_status() == Some(SyncStatus::Online)).await;
    Device { client, events, token: creds.token, id: creds.id, _data: data }
}

fn js_peer(server: &Server, token: &str, note_id: &str, append: &str) -> serde_json::Value {
    let out = Command::new("node")
        .current_dir(repo_root())
        .arg(repo_root().join("core/tests/js-peer.mjs"))
        .args([&format!("ws://127.0.0.1:{}/sync", server.port), token, &format!("note:{note_id}"), append])
        .output()
        .expect("node");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "js peer failed: {stdout} {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_str(stdout.lines().next().unwrap()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn registration_requires_the_registration_token() {
    let server = Server::start();
    let err = register_device(server.url(), "wrong-token".into(), "x".into()).await.unwrap_err();
    assert!(matches!(err, CoreError::Unauthorized), "{err:?}");
    let a = device(&server, "Mac").await;
    let devices = a.client.devices().await.unwrap();
    assert_eq!(devices.len(), 1);
    assert!(devices[0].current);
    assert_eq!(devices[0].name, "Mac");
    a.client.rename_this_device("MacBook".into()).await.unwrap();
    assert_eq!(a.client.devices().await.unwrap()[0].name, "MacBook");
}

#[tokio::test(flavor = "multi_thread")]
async fn two_devices_edit_the_same_note() {
    let server = Server::start();
    let a = device(&server, "a").await;
    let b = device(&server, "b").await;

    let note = a.client.create_note().unwrap();
    note.set_body("Shopping\nmilk".into());
    assert!(note.add_tag("home".into()));
    let id = note.id();

    // B learns about the note from the index broadcast, then opens it.
    until("index broadcast", || b.events.notes_changed.load(Ordering::SeqCst) > 0).await;
    let list = b.client.notes().await.unwrap();
    assert_eq!(list[0].id, id);
    assert_eq!(list[0].title, "Shopping");
    assert_eq!(list[0].tags, vec!["home"]);
    let on_b = b.client.open_note(id.clone()).unwrap();
    until("initial sync", || on_b.body() == "Shopping\nmilk").await;

    // Simultaneous edits at different places merge on both sides.
    note.edit_body(8, 0, " list".into());
    on_b.set_body("Shopping\nmilk\neggs 😀".into());
    let want = "Shopping list\nmilk\neggs 😀";
    until("convergence", || note.body() == want && on_b.body() == want).await;
    assert!(b.events.note_changed.lock().unwrap().contains(&id));

    // The server's own view (from its Yjs copy) agrees.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let hits = a.client.search("eggs".into()).await.unwrap();
        if hits.iter().any(|h| h.id == id) {
            break;
        }
        assert!(Instant::now() < deadline, "search never found the edit");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn interoperates_with_the_javascript_client() {
    let server = Server::start();
    let a = device(&server, "rust").await;
    let note = a.client.create_note().unwrap();
    note.set_body("From Rust 日本語".into());
    note.add_tag("仕事".into());
    let id = note.id();
    until("acknowledged", || a.client.pending_note_ids().is_empty()).await;

    let seen = js_peer(&server, &a.token, &id, " + from JS");
    assert_eq!(seen["body"], "From Rust 日本語");
    assert_eq!(seen["tags"], serde_json::json!(["仕事"]));
    assert_eq!(seen["createdAtType"], "number");
    until("JS edit", || note.body() == "From Rust 日本語 + from JS").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn offline_edits_are_sent_after_reconnecting() {
    let mut server = Server::start();
    let a = device(&server, "a").await;
    let note = a.client.create_note().unwrap();
    note.set_body("before".into());
    let id = note.id();
    until("acknowledged", || a.client.pending_note_ids().is_empty()).await;

    server.stop();
    until("offline", || a.events.last_status() == Some(SyncStatus::Offline)).await;
    note.set_body("before, and written offline".into());
    let created_offline = a.client.create_note().unwrap();
    created_offline.set_body("new while offline".into());
    until("pending recorded", || a.client.pending_note_ids().len() == 2).await;
    // Offline, the list still shows everything this device has.
    let titles: Vec<String> = a.client.notes().await.unwrap().into_iter().map(|n| n.title).collect();
    assert!(titles.contains(&"new while offline".to_string()));

    server.restart();
    until("pending sent", || a.client.pending_note_ids().is_empty()).await;
    let seen = js_peer(&server, &a.token, &id, "");
    assert_eq!(seen["body"], "before, and written offline");
    let seen = js_peer(&server, &a.token, &created_offline.id(), "");
    assert_eq!(seen["body"], "new while offline");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_revoked_device_stops_syncing() {
    let server = Server::start();
    let a = device(&server, "a").await;
    let b = device(&server, "b").await;
    a.client.revoke_device(b.id.clone()).await.unwrap();
    until("unauthorized", || b.events.last_status() == Some(SyncStatus::Unauthorized)).await;
    let err = b.client.devices().await.unwrap_err();
    assert!(matches!(err, CoreError::Unauthorized), "{err:?}");
    // It does not keep retrying with the refused token.
    let count = b.events.statuses.lock().unwrap().len();
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(b.events.statuses.lock().unwrap().len(), count);

    // A new registration brings it back.
    let creds = register_device(server.url(), REGISTRATION_TOKEN.into(), "b again".into()).await.unwrap();
    b.client.reconnect(Some(creds.token));
    until("online again", || b.events.last_status() == Some(SyncStatus::Online)).await;
    assert!(b.client.devices().await.is_ok());
}
