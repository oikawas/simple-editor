//! Keeps open notes in sync with the server over one WebSocket.
//!
//! Each note is a Yjs document named `note:<id>`; `__index` is an empty
//! document whose only purpose is to receive "a note changed" broadcasts.
//! Local edits are saved on the device first and marked pending, then sent;
//! a note stops being pending once the server acknowledges every change.

use crate::note::{NoteDoc, REMOTE_ORIGIN};
use crate::protocol::{self, Incoming};
use crate::store::LocalStore;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::{interval, Instant};
use tokio_tungstenite::tungstenite::Message;
use yrs::sync::SyncMessage;
use yrs::{Origin, TransactionMut};
use yrs::UpdateEvent;

pub const INDEX_DOC: &str = "__index";
const KEEPALIVE: Duration = Duration::from_secs(25);
// The server drops connections idle for 60 seconds; treat ours as dead sooner.
const SILENCE_LIMIT: Duration = Duration::from_secs(55);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const RATE_LIMIT_WAIT: Duration = Duration::from_secs(60);
// Key of the update observer this engine registers on each note's document.
const OBSERVER_KEY: &str = "simple-editor-sync";

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum SyncStatus {
    Connecting,
    Online,
    Offline,
    /// The device token was refused (revoked or invalid). Sync stops until
    /// the app supplies a new token.
    Unauthorized,
    /// Too many failed attempts from this address; sync retries later.
    RateLimited,
}

pub trait SyncEvents: Send + Sync {
    fn status(&self, status: SyncStatus);
    /// Some note changed on the server; the list may be out of date.
    fn index_changed(&self);
    /// Changes from elsewhere arrived for an open note.
    fn note_changed(&self, id: &str);
}

pub fn doc_name(id: &str) -> String {
    format!("note:{id}")
}

enum Command {
    Open(String, Arc<NoteDoc>),
    Close(String),
    Local(String, Vec<u8>),
    Reconnect(Option<String>),
    Shutdown,
}

#[derive(Clone)]
pub struct SyncHandle {
    tx: mpsc::UnboundedSender<Command>,
}

impl SyncHandle {
    /// Starts syncing a note. Local changes are picked up from this call on,
    /// even before the background task gets to the note.
    pub fn open(&self, id: &str, note: Arc<NoteDoc>) {
        let name = doc_name(id);
        let tx = self.tx.clone();
        let doc_name = name.clone();
        let remote = Origin::from(REMOTE_ORIGIN);
        // Changes from the server or storage carry the remote origin and must
        // not be sent back.
        let _ = note.doc().observe_update_v1(OBSERVER_KEY, move |txn: &TransactionMut, event: &UpdateEvent| {
            if txn.origin() != Some(&remote) {
                let _ = tx.send(Command::Local(doc_name.clone(), event.update.clone()));
            }
        });
        let _ = self.tx.send(Command::Open(name, note));
    }

    pub fn close(&self, id: &str, note: &NoteDoc) {
        let _ = note.doc().unobserve_update_v1(OBSERVER_KEY);
        let _ = self.tx.send(Command::Close(doc_name(id)));
    }

    /// Reconnects now, optionally with a new device token.
    pub fn reconnect(&self, token: Option<String>) {
        let _ = self.tx.send(Command::Reconnect(token));
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(Command::Shutdown);
    }
}

struct Entry {
    note: Arc<NoteDoc>,
    /// Changes sent but not yet acknowledged, counting the initial sync.
    unsynced: u32,
}

pub struct SyncConfig {
    pub ws_url: String,
    pub token: String,
}

pub fn start(
    runtime: &tokio::runtime::Handle,
    config: SyncConfig,
    store: Arc<LocalStore>,
    events: Arc<dyn SyncEvents>,
) -> SyncHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = SyncHandle { tx };
    let engine = Engine { config, store, events, rx, entries: HashMap::new() };
    runtime.spawn(engine.run());
    handle
}

struct Engine {
    config: SyncConfig,
    store: Arc<LocalStore>,
    events: Arc<dyn SyncEvents>,
    rx: mpsc::UnboundedReceiver<Command>,
    entries: HashMap<String, Entry>,
}

/// Why a connection ended.
enum End {
    Dropped,
    Unauthorized,
    RateLimited,
    Reconnect,
    Shutdown,
}

/// Messages to send on the current connection.
type Outbox = Vec<Vec<u8>>;

impl Engine {
    async fn run(mut self) {
        self.open(INDEX_DOC.to_owned(), Arc::new(NoteDoc::new()));
        let mut backoff = Duration::from_secs(1);
        let mut wait: Option<Duration> = None;
        loop {
            if let Some(d) = wait.take() {
                match self.idle(Some(d)).await {
                    End::Shutdown => return,
                    End::Reconnect => backoff = Duration::from_secs(1),
                    _ => {}
                }
            }
            self.events.status(SyncStatus::Connecting);
            let end = self.connection().await;
            match end {
                End::Shutdown => return,
                End::Unauthorized => {
                    self.events.status(SyncStatus::Unauthorized);
                    // Retrying a refused token would only count as more failures.
                    match self.idle(None).await {
                        End::Shutdown => return,
                        _ => backoff = Duration::from_secs(1),
                    }
                }
                End::RateLimited => {
                    self.events.status(SyncStatus::RateLimited);
                    wait = Some(RATE_LIMIT_WAIT);
                }
                End::Reconnect => backoff = Duration::from_secs(1),
                End::Dropped => {
                    self.events.status(SyncStatus::Offline);
                    wait = Some(backoff);
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
    }

    /// Handles commands while disconnected, until `limit` passes (None: until
    /// a reconnect is requested).
    async fn idle(&mut self, limit: Option<Duration>) -> End {
        let deadline = limit.map(|d| Instant::now() + d);
        loop {
            let cmd = match deadline {
                Some(d) => match tokio::time::timeout_at(d, self.rx.recv()).await {
                    Ok(cmd) => cmd,
                    Err(_) => return End::Dropped,
                },
                None => self.rx.recv().await,
            };
            let mut outbox = Outbox::new();
            match self.command(cmd, false, &mut outbox) {
                Some(end) => return end,
                None => {}
            }
        }
    }

    /// Applies a command. Returns how the connection should end, if it should.
    fn command(&mut self, cmd: Option<Command>, online: bool, outbox: &mut Outbox) -> Option<End> {
        match cmd {
            None | Some(Command::Shutdown) => return Some(End::Shutdown),
            Some(Command::Reconnect(token)) => {
                if let Some(t) = token {
                    self.config.token = t;
                }
                return Some(End::Reconnect);
            }
            Some(Command::Open(name, note)) => {
                if !self.entries.contains_key(&name) {
                    self.open(name.clone(), note);
                    if online {
                        self.start_doc(&name, outbox);
                    }
                }
            }
            Some(Command::Close(name)) => {
                self.entries.remove(&name);
            }
            Some(Command::Local(name, update)) => {
                let Some(entry) = self.entries.get_mut(&name) else { return None };
                if let Some(id) = name.strip_prefix("note:") {
                    let _ = self.store.save_doc(&name, &entry.note.encode_state());
                    let _ = self.store.set_pending(id, true);
                }
                if online {
                    entry.unsynced += 1;
                    outbox.push(protocol::sync(&name, &SyncMessage::Update(update)));
                }
            }
        }
        None
    }

    fn open(&mut self, name: String, note: Arc<NoteDoc>) {
        self.entries.insert(name, Entry { note, unsynced: 0 });
    }

    /// Authenticates a document on the current connection and starts the
    /// Yjs sync handshake.
    fn start_doc(&mut self, name: &str, outbox: &mut Outbox) {
        let Some(entry) = self.entries.get_mut(name) else { return };
        entry.unsynced = 1;
        outbox.push(protocol::auth(name, &self.config.token));
        outbox.push(protocol::sync(name, &SyncMessage::SyncStep1(entry.note.state_vector())));
    }

    async fn connection(&mut self) -> End {
        let connector = if self.config.ws_url.starts_with("wss:") {
            match crate::tls::client_config() {
                Ok(c) => Some(tokio_tungstenite::Connector::Rustls(c)),
                Err(_) => return End::Dropped,
            }
        } else {
            None
        };
        let connect = tokio_tungstenite::connect_async_tls_with_config(&self.config.ws_url, None, true, connector);
        let ws = match tokio::time::timeout(Duration::from_secs(15), connect).await {
            Ok(Ok((ws, _))) => ws,
            _ => return End::Dropped,
        };
        let (mut sink, mut stream) = ws.split();

        let mut outbox = Outbox::new();
        let names: Vec<String> = self.entries.keys().cloned().collect();
        for name in &names {
            self.start_doc(name, &mut outbox);
        }
        let mut online = false;
        let mut last_heard = Instant::now();
        let mut keepalive = interval(KEEPALIVE);
        keepalive.tick().await;

        loop {
            for msg in outbox.drain(..) {
                if sink.send(Message::binary(msg)).await.is_err() {
                    return End::Dropped;
                }
            }
            tokio::select! {
                msg = stream.next() => {
                    let data = match msg {
                        Some(Ok(Message::Binary(data))) => data,
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return End::Dropped,
                        Some(Ok(_)) => continue,
                    };
                    last_heard = Instant::now();
                    if !online {
                        online = true;
                        self.events.status(SyncStatus::Online);
                    }
                    let Ok(Some((name, message))) = protocol::decode(&data) else { continue };
                    if let Some(end) = self.incoming(&name, message, &mut outbox) {
                        let _ = sink.close().await;
                        return end;
                    }
                }
                cmd = self.rx.recv() => {
                    if let Some(end) = self.command(cmd, true, &mut outbox) {
                        let _ = sink.close().await;
                        return end;
                    }
                }
                _ = keepalive.tick() => {
                    if last_heard.elapsed() > SILENCE_LIMIT {
                        return End::Dropped;
                    }
                    // The reply also tells us the connection is alive.
                    outbox.push(protocol::sync(INDEX_DOC, &SyncMessage::SyncStep1(Default::default())));
                }
            }
        }
    }

    fn incoming(&mut self, name: &str, message: Incoming, outbox: &mut Outbox) -> Option<End> {
        let id = name.strip_prefix("note:").map(str::to_owned);
        match message {
            Incoming::PermissionDenied(reason) => {
                return Some(if reason == "rate-limited" { End::RateLimited } else { End::Unauthorized });
            }
            Incoming::Close(reason) => {
                return Some(if reason == "unauthorized" { End::Unauthorized } else { End::Dropped });
            }
            Incoming::TokenRequest => outbox.push(protocol::auth(name, &self.config.token)),
            Incoming::Stateless(_) if name == INDEX_DOC => self.events.index_changed(),
            Incoming::Sync(SyncMessage::SyncStep1(remote)) => {
                let entry = self.entries.get(name)?;
                let diff = entry.note.encode_diff(&remote);
                outbox.push(protocol::sync(name, &SyncMessage::SyncStep2(diff)));
            }
            Incoming::Sync(SyncMessage::SyncStep2(update)) | Incoming::Sync(SyncMessage::Update(update)) => {
                let entry = self.entries.get(name)?;
                if entry.note.apply_remote(&update).is_ok() {
                    if let Some(id) = &id {
                        let _ = self.store.save_doc(name, &entry.note.encode_state());
                        self.events.note_changed(id);
                    }
                }
            }
            Incoming::SyncStatus(applied) => {
                let entry = self.entries.get_mut(name)?;
                if applied && entry.unsynced > 0 {
                    entry.unsynced -= 1;
                    if entry.unsynced == 0 {
                        if let Some(id) = &id {
                            let _ = self.store.set_pending(id, false);
                        }
                    }
                }
            }
            Incoming::Authenticated | Incoming::Stateless(_) | Incoming::Ignored => {}
        }
        None
    }
}
