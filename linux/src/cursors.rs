//! Where the cursor was in each note when it was last left, kept per device
//! so a note opens where the user stopped. Offsets are in characters, as GTK
//! counts them.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

/// How many notes' cursors are kept; the oldest are dropped beyond this.
pub const LIMIT: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Entry {
    cursor: i32,
    bound: i32,
    /// When it was saved (ms), to drop the oldest entries first.
    at: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Cursors(HashMap<String, Entry>);

impl Cursors {
    pub fn load(path: &Path) -> Cursors {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_vec(self) {
            let _ = std::fs::write(path, json);
        }
    }

    /// The saved cursor and selection bound of a note, fitted to a text of
    /// `length` characters.
    pub fn get(&self, id: &str, length: i32) -> Option<(i32, i32)> {
        let e = self.0.get(id)?;
        Some((e.cursor.clamp(0, length), e.bound.clamp(0, length)))
    }

    /// Records a note's cursor. One at the start is the default and is not kept.
    pub fn set(&mut self, id: &str, cursor: i32, bound: i32, now: i64) {
        if cursor == 0 && bound == 0 {
            self.0.remove(id);
            return;
        }
        self.0.insert(id.to_owned(), Entry { cursor, bound, at: now });
        if self.0.len() > LIMIT {
            let mut ids: Vec<(String, i64)> = self.0.iter().map(|(id, e)| (id.clone(), e.at)).collect();
            ids.sort_by(|a, b| b.1.cmp(&a.1));
            for (old, _) in ids.into_iter().skip(LIMIT) {
                self.0.remove(&old);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_the_saved_cursor_fitted_to_the_text() {
        let mut c = Cursors::default();
        assert_eq!(c.get("a", 100), None);
        c.set("a", 20, 12, 1);
        assert_eq!(c.get("a", 100), Some((20, 12)));
        assert_eq!(c.get("a", 15), Some((15, 12)));
    }

    #[test]
    fn a_cursor_at_the_start_is_not_kept() {
        let mut c = Cursors::default();
        c.set("a", 5, 5, 1);
        c.set("a", 0, 0, 2);
        assert_eq!(c.get("a", 10), None);
    }

    #[test]
    fn drops_the_oldest_beyond_the_limit() {
        let mut c = Cursors::default();
        for i in 0..=LIMIT as i64 {
            c.set(&format!("n{i}"), 1, 1, i);
        }
        assert_eq!(c.get("n0", 10), None);
        assert_eq!(c.get("n1", 10), Some((1, 1)));
        assert_eq!(c.get(&format!("n{LIMIT}"), 10), Some((1, 1)));
    }

    #[test]
    fn survives_a_round_trip_and_broken_files() {
        let dir = std::env::temp_dir().join(format!("se-cursors-{}", std::process::id()));
        let path = dir.join("cursors.json");
        let mut c = Cursors::default();
        c.set("a", 3, 4, 1);
        c.save(&path);
        assert_eq!(Cursors::load(&path).get("a", 10), Some((3, 4)));
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(Cursors::load(&path).get("a", 10), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
