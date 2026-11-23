//! Keeps open notes in sync with the server over one WebSocket.
//!
//! Each note is a Yjs document named `note:<id>`; `__index` is an empty
//! document whose only purpose is to receive "a note changed" broadcasts.
//! Local edits are saved on the device first and marked pending, then sent;
//! a note stops being pending once the server acknowledges every change.

use crate::note::{NoteDoc, REMOTE_ORIGIN};
use crate::protocol::{self, AwarenessEntry, Incoming};
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
// Awareness states not renewed for this long are dropped (as y-protocols
// does; the server drops ours likewise, so ours is renewed with each keepalive).
const AWARENESS_TIMEOUT: Duration = Duration::from_secs(30);

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
    /// The other devices with a note open changed (their names, sorted).
    fn editors_changed(&self, id: &str, names: Vec<String>);
}

pub fn doc_name(id: &str) -> String {
    format!("note:{id}")
}

enum Command {
    Open(String, Arc<NoteDoc>),
    Close(String),
    Local(String, Vec<u8>),
    /// The note the user is looking at, announced to other devices.
    Active(Option<String>),
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

    /// The note shown to the user (None: none). Other devices see this
    /// device as editing it.
    pub fn set_active(&self, id: Option<&str>) {
        let _ = self.tx.send(Command::Active(id.map(doc_name)));
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
    /// Other clients with the document open, by Yjs client ID.
    peers: HashMap<u64, Peer>,
    /// The clock of this client's awareness state.
    clock: u32,
}

struct Peer {
    clock: u32,
    name: Option<String>,
    heard: Instant,
}

impl Entry {
    /// The other devices' names, sorted and without repeats.
    fn editor_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.peers.values().filter_map(|p| p.name.clone()).collect();
        names.sort();
        names.dedup();
        names
    }
}

/// The device name in an awareness state (`{"user":{"name":...}}`, as the
/// web app sets it).
fn state_name(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let name = value.get("user")?.get("name")?.as_str()?.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

pub struct SyncConfig {
    pub ws_url: String,
    pub token: String,
    /// Fixed wait between failing attempts; None to back off (see Backoff).
    pub retry_interval: Option<Duration>,
    /// This device's name, shown to other devices editing the same note;
    /// None to announce nothing.
    pub device_name: Option<String>,
}

pub fn start(
    runtime: &tokio::runtime::Handle,
    config: SyncConfig,
    store: Arc<LocalStore>,
    events: Arc<dyn SyncEvents>,
) -> SyncHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let handle = SyncHandle { tx };
    let engine = Engine { config, store, events, rx, entries: HashMap::new(), went_online: false, active: None };
    runtime.spawn(engine.run());
    handle
}

struct Engine {
    config: SyncConfig,
    store: Arc<LocalStore>,
    events: Arc<dyn SyncEvents>,
    rx: mpsc::UnboundedReceiver<Command>,
    entries: HashMap<String, Entry>,
    /// The current (or last) connection reached the server.
    went_online: bool,
    /// The document of the note the user is looking at.
    active: Option<String>,
}

/// Waits between reconnection attempts: 1 s, doubling up to MAX_BACKOFF.
struct Backoff(Duration);

impl Backoff {
    const FIRST: Duration = Duration::from_secs(1);

    fn new() -> Self {
        Backoff(Self::FIRST)
    }

    fn reset(&mut self) {
        self.0 = Self::FIRST;
    }

    /// The wait before the next attempt; later ones wait longer.
    fn next_wait(&mut self) -> Duration {
        let wait = self.0;
        self.0 = (self.0 * 2).min(MAX_BACKOFF);
        wait
    }
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
        let mut backoff = Backoff::new();
        let mut wait: Option<Duration> = None;
        loop {
            if let Some(d) = wait.take() {
                match self.idle(Some(d)).await {
                    End::Shutdown => return,
                    End::Reconnect => backoff.reset(),
                    _ => {}
                }
            }
            self.events.status(SyncStatus::Connecting);
            let end = self.connection().await;
            // Presence is only known while connected.
            self.forget_peers();
            match end {
                End::Shutdown => return,
                End::Unauthorized => {
                    self.events.status(SyncStatus::Unauthorized);
                    // Retrying a refused token would only count as more failures.
                    match self.idle(None).await {
                        End::Shutdown => return,
                        _ => backoff.reset(),
                    }
                }
                End::RateLimited => {
                    self.events.status(SyncStatus::RateLimited);
                    wait = Some(RATE_LIMIT_WAIT);
                }
                End::Reconnect => backoff.reset(),
                End::Dropped => {
                    self.events.status(SyncStatus::Offline);
                    // A connection that worked starts the waits over; only
                    // attempts failing in a row wait longer and longer.
                    if self.went_online {
                        backoff.reset();
                    }
                    wait = Some(match self.config.retry_interval {
                        // One quick retry after a working connection drops,
                        // then the fixed interval.
                        Some(interval) if !self.went_online => interval,
                        _ => backoff.next_wait(),
                    });
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
                if self.active.as_deref() == Some(name.as_str()) {
                    if online {
                        self.announce(&name, false, outbox);
                    }
                    self.active = None;
                }
                self.entries.remove(&name);
            }
            Some(Command::Active(name)) => {
                if self.active != name {
                    if let (Some(old), true) = (self.active.clone(), online) {
                        self.announce(&old, false, outbox);
                    }
                    self.active = name.clone();
                    if let (Some(new), true) = (name, online) {
                        self.announce(&new, true, outbox);
                    }
                }
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
        self.entries.insert(name, Entry { note, unsynced: 0, peers: HashMap::new(), clock: 0 });
    }

    /// Sends this device's awareness state for a document: present (with the
    /// device name) or gone.
    fn announce(&mut self, name: &str, present: bool, outbox: &mut Outbox) {
        let Some(device) = self.config.device_name.clone() else { return };
        let Some(entry) = self.entries.get_mut(name) else { return };
        entry.clock += 1;
        let state = present.then(|| serde_json::json!({ "user": { "name": device } }).to_string());
        let entry = AwarenessEntry { client: entry.note.doc().client_id().get(), clock: entry.clock, state };
        outbox.push(protocol::awareness(name, &[entry]));
    }

    /// Records other clients' awareness, telling the app when the names change.
    fn awareness(&mut self, name: &str, updates: Vec<AwarenessEntry>) {
        let own_name = self.config.device_name.clone();
        let Some(entry) = self.entries.get_mut(name) else { return };
        let own = entry.note.doc().client_id().get();
        let before = entry.editor_names();
        for u in updates {
            if u.client == own {
                continue;
            }
            if entry.peers.get(&u.client).is_some_and(|p| p.clock > u.clock) {
                continue;
            }
            match u.state {
                None => {
                    entry.peers.remove(&u.client);
                }
                Some(json) => {
                    // A state this device left behind (say, before the app
                    // restarted) carries its own name; it is not someone else.
                    let name = state_name(&json).filter(|n| Some(n) != own_name.as_ref());
                    entry.peers.insert(u.client, Peer { clock: u.clock, name, heard: Instant::now() });
                }
            }
        }
        let after = entry.editor_names();
        if after != before {
            if let Some(id) = name.strip_prefix("note:") {
                self.events.editors_changed(id, after);
            }
        }
    }

    /// Drops awareness states that were not renewed in time.
    fn expire_peers(&mut self) {
        for (name, entry) in &mut self.entries {
            let before = entry.editor_names();
            entry.peers.retain(|_, p| p.heard.elapsed() < AWARENESS_TIMEOUT);
            let after = entry.editor_names();
            if after != before {
                if let Some(id) = name.strip_prefix("note:") {
                    self.events.editors_changed(id, after);
                }
            }
        }
    }

    /// Forgets every other client, when the connection ends.
    fn forget_peers(&mut self) {
        for (name, entry) in &mut self.entries {
            if entry.peers.is_empty() {
                continue;
            }
            let had = !entry.editor_names().is_empty();
            entry.peers.clear();
            if let (true, Some(id)) = (had, name.strip_prefix("note:")) {
                self.events.editors_changed(id, Vec::new());
            }
        }
    }

    /// Authenticates a document on the current connection and starts the
    /// Yjs sync handshake.
    fn start_doc(&mut self, name: &str, outbox: &mut Outbox) {
        let Some(entry) = self.entries.get_mut(name) else { return };
        entry.unsynced = 1;
        outbox.push(protocol::auth(name, &self.config.token));
        outbox.push(protocol::sync(name, &SyncMessage::SyncStep1(entry.note.state_vector())));
        if self.active.as_deref() == Some(name) {
            self.announce(name, true, outbox);
        }
    }

    async fn connection(&mut self) -> End {
        self.went_online = false;
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
                        self.went_online = true;
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
                    // Presence is renewed before the server lets it lapse.
                    if let Some(active) = self.active.clone() {
                        self.announce(&active, true, &mut outbox);
                    }
                    self.expire_peers();
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
            Incoming::Awareness(updates) => self.awareness(name, updates),
            Incoming::QueryAwareness => {
                if self.active.as_deref() == Some(name) {
                    self.announce(name, true, outbox);
                }
            }
            Incoming::Authenticated | Incoming::Stateless(_) => {}
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_name_from_awareness_state() {
        assert_eq!(state_name(r##"{"user":{"name":"iPhone","color":"#2f6fde"},"cursor":null}"##), Some("iPhone".into()));
        assert_eq!(state_name(r#"{"user":{"name":"  "}}"#), None);
        assert_eq!(state_name(r#"{"cursor":1}"#), None);
        assert_eq!(state_name("not json"), None);
    }

    #[test]
    fn backoff_doubles_up_to_the_limit_and_resets() {
        let mut b = Backoff::new();
        let waits: Vec<u64> = (0..7).map(|_| b.next_wait().as_secs()).collect();
        assert_eq!(waits, [1, 2, 4, 8, 16, 30, 30]);
        b.reset();
        assert_eq!(b.next_wait().as_secs(), 1);
    }
}
