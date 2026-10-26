//! The API the native apps call, exported through UniFFI.

use crate::api::{self, Api, DeviceCredentials, DeviceInfo, SearchHit, Version, VersionInfo};
use crate::error::CoreError;
use crate::note::{NoteDoc, NoteSummary};
use crate::store::LocalStore;
use crate::sync::{self, doc_name, SyncConfig, SyncEvents, SyncHandle, SyncStatus};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, RwLock};

fn runtime() -> &'static tokio::runtime::Runtime {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("simple-editor-core")
            .enable_all()
            .build()
            .expect("tokio runtime")
    })
}

/// Runs a future on the core's runtime, so it can be awaited from any
/// foreign executor (Swift, Kotlin, GLib).
async fn on_runtime<T: Send + 'static>(f: impl Future<Output = T> + Send + 'static) -> T {
    runtime().spawn(f).await.expect("core task panicked")
}

fn sync_url(server_url: &str) -> String {
    let base = server_url.trim_end_matches('/');
    let ws = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_owned()
    };
    format!("{ws}/sync")
}

/// Registers this device with the server's registration token (AUTH_TOKEN).
/// Store the returned token securely (Keychain, etc.); the registration token
/// itself should not be kept.
#[uniffi::export]
pub async fn register_device(
    server_url: String,
    registration_token: String,
    device_name: String,
) -> Result<DeviceCredentials, CoreError> {
    on_runtime(async move {
        let http = api::http_client()?;
        api::register_device(&http, &server_url, &registration_token, &device_name).await
    })
    .await
}

#[derive(Debug, Clone, uniffi::Record)]
pub struct ClientConfig {
    pub server_url: String,
    pub device_token: String,
    /// A directory the app owns, for notes kept on the device.
    pub data_dir: String,
}

/// Callbacks to the app. They arrive on a background thread.
#[uniffi::export(with_foreign)]
pub trait ClientListener: Send + Sync {
    fn on_status(&self, status: SyncStatus);
    /// The note list may have changed; fetch it again.
    fn on_notes_changed(&self);
    /// An open note changed on another device; re-read it.
    fn on_note_changed(&self, id: String);
}

struct Events(Arc<dyn ClientListener>);

impl SyncEvents for Events {
    fn status(&self, status: SyncStatus) {
        self.0.on_status(status);
    }
    fn index_changed(&self) {
        self.0.on_notes_changed();
    }
    fn note_changed(&self, id: &str) {
        self.0.on_note_changed(id.to_owned());
    }
}

#[derive(uniffi::Object)]
pub struct Client {
    api: RwLock<Api>,
    store: Arc<LocalStore>,
    sync: SyncHandle,
    open: Mutex<HashMap<String, Arc<NoteDoc>>>,
}

#[uniffi::export]
impl Client {
    /// Starts syncing in the background. Notes with changes the server has
    /// not acknowledged are reopened so they are sent once online.
    #[uniffi::constructor]
    pub fn new(config: ClientConfig, listener: Arc<dyn ClientListener>) -> Result<Arc<Self>, CoreError> {
        let store = Arc::new(LocalStore::open(&PathBuf::from(&config.data_dir))?);
        let http = api::http_client()?;
        let sync = sync::start(
            runtime().handle(),
            SyncConfig { ws_url: sync_url(&config.server_url), token: config.device_token.clone() },
            store.clone(),
            Arc::new(Events(listener)),
        );
        let client = Arc::new(Client {
            api: RwLock::new(Api::new(http, &config.server_url, &config.device_token)),
            store,
            sync,
            open: Mutex::new(HashMap::new()),
        });
        for id in client.store.pending()? {
            client.doc(&id)?;
        }
        Ok(client)
    }

    pub fn open_note(&self, id: String) -> Result<Arc<Note>, CoreError> {
        Ok(Arc::new(Note { id: id.clone(), doc: self.doc(&id)? }))
    }

    pub fn create_note(&self) -> Result<Arc<Note>, CoreError> {
        let id = uuid::Uuid::new_v4().to_string();
        let doc = self.doc(&id)?;
        doc.initialize();
        Ok(Arc::new(Note { id, doc }))
    }

    /// Stops syncing a note that is no longer shown. Notes with unsent
    /// changes stay open until the server has them.
    pub fn close_note(&self, id: String) {
        if self.store.pending().map(|p| p.contains(&id)).unwrap_or(true) {
            return;
        }
        if let Some(doc) = self.open.lock().unwrap().remove(&id) {
            self.sync.close(&id, &doc);
        }
    }

    /// The note list, newest first. Offline, the last fetched list is used.
    /// Notes created or changed here but not yet on the server are included.
    pub async fn notes(&self) -> Result<Vec<NoteSummary>, CoreError> {
        let api = self.api();
        let fetched = on_runtime(async move { api.notes().await }).await;
        let mut notes = match fetched {
            Ok(list) => {
                self.store.cache_notes(&list)?;
                list
            }
            Err(CoreError::Network { .. }) | Err(CoreError::Server { .. }) => self.store.cached_notes()?,
            Err(e) => return Err(e),
        };
        let local: Vec<NoteSummary> = {
            let open = self.open.lock().unwrap();
            open.iter().map(|(id, doc)| doc.summary(id)).collect()
        };
        for summary in local {
            match notes.iter_mut().find(|n| n.id == summary.id) {
                Some(n) => *n = summary,
                None => notes.push(summary),
            }
        }
        notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(notes)
    }

    /// Notes with changes the server has not acknowledged yet.
    pub fn pending_note_ids(&self) -> Vec<String> {
        self.store.pending().unwrap_or_default()
    }

    /// The last fetched note list, for showing something before `notes()` returns.
    pub fn cached_notes(&self) -> Result<Vec<NoteSummary>, CoreError> {
        self.store.cached_notes()
    }

    pub async fn search(&self, query: String) -> Result<Vec<SearchHit>, CoreError> {
        let api = self.api();
        on_runtime(async move { api.search(&query).await }).await
    }

    pub async fn versions(&self, note_id: String) -> Result<Vec<VersionInfo>, CoreError> {
        let api = self.api();
        on_runtime(async move { api.versions(&note_id).await }).await
    }

    pub async fn version(&self, note_id: String, version_id: i64) -> Result<Version, CoreError> {
        let api = self.api();
        on_runtime(async move { api.version(&note_id, version_id).await }).await
    }

    pub async fn devices(&self) -> Result<Vec<DeviceInfo>, CoreError> {
        let api = self.api();
        on_runtime(async move { api.devices().await }).await
    }

    pub async fn rename_this_device(&self, name: String) -> Result<(), CoreError> {
        let api = self.api();
        on_runtime(async move { api.rename_this_device(&name).await }).await
    }

    pub async fn revoke_device(&self, device_id: String) -> Result<(), CoreError> {
        let api = self.api();
        on_runtime(async move { api.revoke_device(&device_id).await }).await
    }

    /// Saves all notes as a zip (text files plus notes.json) at `path`.
    pub async fn export_zip(&self, path: String, include_trash: bool) -> Result<(), CoreError> {
        let api = self.api();
        let bytes = on_runtime(async move { api.export_zip(include_trash).await }).await?;
        std::fs::write(path, bytes).map_err(CoreError::other)
    }

    /// Reconnects now, e.g. after the network returns or with a new device token.
    pub fn reconnect(&self, device_token: Option<String>) {
        if let Some(token) = &device_token {
            let mut api = self.api.write().unwrap();
            *api = api.with_token(token);
        }
        self.sync.reconnect(device_token);
    }

    /// Stops syncing. The client cannot be used afterwards.
    pub fn shutdown(&self) {
        self.sync.shutdown();
    }
}

impl Client {
    fn api(&self) -> Api {
        self.api.read().unwrap().clone()
    }

    fn doc(&self, id: &str) -> Result<Arc<NoteDoc>, CoreError> {
        let mut open = self.open.lock().unwrap();
        if let Some(doc) = open.get(id) {
            return Ok(doc.clone());
        }
        let doc = Arc::new(NoteDoc::new());
        if let Some(state) = self.store.load_doc(&doc_name(id))? {
            // Applied with the remote origin, so it is not mistaken for an edit.
            doc.apply_remote(&state).map_err(CoreError::other)?;
        }
        open.insert(id.to_owned(), doc.clone());
        self.sync.open(id, doc.clone());
        Ok(doc)
    }
}

/// An open note. Edits apply immediately and sync in the background.
#[derive(uniffi::Object)]
pub struct Note {
    id: String,
    doc: Arc<NoteDoc>,
}

#[uniffi::export]
impl Note {
    pub fn id(&self) -> String {
        self.id.clone()
    }

    pub fn body(&self) -> String {
        self.doc.body()
    }

    /// Replaces the whole body; only the part that differs is changed.
    pub fn set_body(&self, body: String) {
        self.doc.set_body(&body);
    }

    /// Replaces `delete` UTF-16 units at `start` with `insert`.
    pub fn edit_body(&self, start: u32, delete: u32, insert: String) {
        self.doc.edit_body(start, delete, &insert);
    }

    pub fn tags(&self) -> Vec<String> {
        self.doc.tags()
    }

    /// Adds a tag (whitespace becomes "-"); false when it is empty or already there.
    pub fn add_tag(&self, tag: String) -> bool {
        self.doc.add_tag(&tag)
    }

    pub fn remove_tag(&self, tag: String) {
        self.doc.remove_tag(&tag);
    }

    pub fn is_deleted(&self) -> bool {
        self.doc.is_deleted()
    }

    /// Moves the note to the trash, or back out of it.
    pub fn set_deleted(&self, deleted: bool) {
        self.doc.set_deleted(deleted);
    }

    pub fn summary(&self) -> NoteSummary {
        self.doc.summary(&self.id)
    }

    /// Replaces the body and tags with a version's.
    pub fn restore(&self, version: Version) {
        self.doc.restore(&version.body, &version.tags);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn sync_url_from_server_url() {
        assert_eq!(super::sync_url("https://192.168.1.10/"), "wss://192.168.1.10/sync");
        assert_eq!(super::sync_url("http://localhost:8080"), "ws://localhost:8080/sync");
    }
}
