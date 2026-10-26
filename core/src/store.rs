//! On-device storage: each note's Yjs state (so notes open and edit offline),
//! which notes have changes the server has not acknowledged, and the last
//! note list fetched from the server.

use crate::error::CoreError;
use crate::note::NoteSummary;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

pub struct LocalStore {
    conn: Mutex<Connection>,
}

impl LocalStore {
    pub fn open(dir: &Path) -> Result<Self, CoreError> {
        std::fs::create_dir_all(dir).map_err(CoreError::other)?;
        let conn = Connection::open(dir.join("local.db"))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS docs (name TEXT PRIMARY KEY, state BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY);
             CREATE TABLE IF NOT EXISTS notes_cache (id TEXT PRIMARY KEY, json TEXT NOT NULL);",
        )?;
        Ok(LocalStore { conn: Mutex::new(conn) })
    }

    pub fn load_doc(&self, name: &str) -> Result<Option<Vec<u8>>, CoreError> {
        let conn = self.conn.lock().unwrap();
        Ok(conn
            .query_row("SELECT state FROM docs WHERE name = ?", [name], |r| r.get(0))
            .optional()?)
    }

    pub fn save_doc(&self, name: &str, state: &[u8]) -> Result<(), CoreError> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO docs (name, state) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state = excluded.state",
            params![name, state],
        )?;
        Ok(())
    }

    pub fn set_pending(&self, id: &str, pending: bool) -> Result<(), CoreError> {
        let conn = self.conn.lock().unwrap();
        if pending {
            conn.execute("INSERT OR IGNORE INTO pending (id) VALUES (?)", [id])?;
        } else {
            conn.execute("DELETE FROM pending WHERE id = ?", [id])?;
        }
        Ok(())
    }

    pub fn pending(&self) -> Result<Vec<String>, CoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM pending")?;
        let ids = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
        Ok(ids)
    }

    pub fn cache_notes(&self, notes: &[NoteSummary]) -> Result<(), CoreError> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM notes_cache", [])?;
        for n in notes {
            let json = serde_json::to_string(n).map_err(CoreError::other)?;
            tx.execute("INSERT INTO notes_cache (id, json) VALUES (?, ?)", params![n.id, json])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn cached_notes(&self) -> Result<Vec<NoteSummary>, CoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT json FROM notes_cache")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut notes = Vec::new();
        for json in rows {
            if let Ok(n) = serde_json::from_str(&json?) {
                notes.push(n);
            }
        }
        Ok(notes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::open(dir.path()).unwrap();
        assert_eq!(store.load_doc("note:a").unwrap(), None);
        store.save_doc("note:a", &[1, 2]).unwrap();
        store.save_doc("note:a", &[3]).unwrap();
        assert_eq!(store.load_doc("note:a").unwrap(), Some(vec![3]));
        store.set_pending("a", true).unwrap();
        store.set_pending("a", true).unwrap();
        store.set_pending("b", true).unwrap();
        store.set_pending("b", false).unwrap();
        assert_eq!(store.pending().unwrap(), vec!["a"]);
        let n = NoteSummary {
            id: "a".into(),
            title: "t".into(),
            preview: String::new(),
            tags: vec![],
            created_at: 1,
            updated_at: 2,
            deleted: false,
        };
        store.cache_notes(&[n.clone()]).unwrap();
        drop(store);
        let reopened = LocalStore::open(dir.path()).unwrap();
        assert_eq!(reopened.cached_notes().unwrap(), vec![n]);
        assert_eq!(reopened.pending().unwrap(), vec!["a"]);
    }
}
