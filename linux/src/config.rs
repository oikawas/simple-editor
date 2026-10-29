//! Settings on disk, and the device token in the desktop keyring.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const APP_ID: &str = "io.github.oikawas.SimpleEditor";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    pub server_url: String,
    pub device_id: String,
    pub device_name: String,
    /// The editor's font as a Pango description ("Noto Sans CJK JP 13");
    /// empty for the system default.
    #[serde(default)]
    pub font: String,
}

fn config_dir() -> PathBuf {
    gtk::glib::user_config_dir().join("simple-editor")
}

/// Where the core keeps notes on this device.
pub fn data_dir() -> PathBuf {
    gtk::glib::user_data_dir().join("simple-editor")
}

pub fn default_device_name() -> String {
    gtk::glib::host_name().to_string()
}

impl Settings {
    pub fn load() -> Settings {
        let mut s: Settings = std::fs::read(config_dir().join("settings.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if s.device_name.is_empty() {
            s.device_name = default_device_name();
        }
        s
    }

    pub fn save(&self) {
        let dir = config_dir();
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(json) = serde_json::to_vec_pretty(self) {
            let _ = std::fs::write(dir.join("settings.json"), json);
        }
    }
}

fn attributes(server_url: &str) -> Vec<(&'static str, String)> {
    vec![("application", APP_ID.to_owned()), ("server", server_url.to_owned())]
}

/// Without a Secret Service (a bare X session, a container) the token goes to
/// a file only this user can read.
fn token_file() -> PathBuf {
    config_dir().join("device-token")
}

fn write_private(path: &PathBuf, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(path.parent().unwrap())?;
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    f.write_all(contents.as_bytes())
}

async fn keyring() -> Option<oo7::Keyring> {
    with_timeout(oo7::Keyring::new(), std::time::Duration::from_secs(3)).await.and_then(Result::ok)
}

pub async fn load_token(server_url: &str) -> Option<String> {
    if let Some(keyring) = keyring().await {
        let attrs = attributes(server_url);
        let attrs: Vec<(&str, &str)> = attrs.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let _ = keyring.unlock().await;
        if let Ok(items) = keyring.search_items(&attrs).await {
            if let Some(item) = items.first() {
                if let Ok(secret) = item.secret().await {
                    return String::from_utf8(secret.to_vec()).ok();
                }
            }
        }
    }
    std::fs::read_to_string(token_file()).ok().map(|t| t.trim().to_owned()).filter(|t| !t.is_empty())
}

pub async fn save_token(server_url: &str, token: &str) {
    if let Some(keyring) = keyring().await {
        let attrs = attributes(server_url);
        let attrs: Vec<(&str, &str)> = attrs.iter().map(|(k, v)| (*k, v.as_str())).collect();
        if keyring.create_item("Simple Editor device token", &attrs, token, true).await.is_ok() {
            let _ = std::fs::remove_file(token_file());
            return;
        }
    }
    if let Err(e) = write_private(&token_file(), token) {
        eprintln!("could not store the device token: {e}");
    }
}

pub async fn clear_token(server_url: &str) {
    if let Some(keyring) = keyring().await {
        let attrs = attributes(server_url);
        let attrs: Vec<(&str, &str)> = attrs.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let _ = keyring.delete(&attrs).await;
    }
    let _ = std::fs::remove_file(token_file());
}

/// Resolves to the future's output, or None if `limit` passes first.
async fn with_timeout<T>(fut: impl std::future::Future<Output = T>, limit: std::time::Duration) -> Option<T> {
    use std::pin::pin;
    use std::task::Poll;
    let mut fut = pin!(fut);
    let mut timeout = gtk::glib::timeout_future(limit);
    std::future::poll_fn(|cx| {
        if let Poll::Ready(v) = fut.as_mut().poll(cx) {
            return Poll::Ready(Some(v));
        }
        if timeout.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}
