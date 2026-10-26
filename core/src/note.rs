//! A note document, with the same shape the server and web client use:
//! `getText("body")`, `getMap("meta")` (createdAt, updatedAt, deleted,
//! restoredAt), and `getMap("tags")` (tag name -> true).

use std::time::{SystemTime, UNIX_EPOCH};
use yrs::types::ToJson;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, GetString, Map, MapRef, Number, OffsetKind, Options, Origin, Out, ReadTxn, StateVector, Text, TextRef,
    Transact, TransactionMut, Update,
};

/// Origin of transactions that bring in changes from elsewhere (the server or
/// local storage); they are not sent back out.
pub const REMOTE_ORIGIN: &str = "remote";

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize, uniffi::Record)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub preview: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted: bool,
}

/// Timestamps are written as floats, as Yjs does for numbers this large.
fn timestamp(ms: i64) -> Any {
    Any::Number(Number::Float(ms as f64))
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn normalize_tag(raw: &str) -> String {
    let joined = raw.split_whitespace().collect::<Vec<_>>().join("-");
    joined.chars().take(64).collect()
}

pub struct NoteDoc {
    doc: Doc,
    body: TextRef,
    meta: MapRef,
    tags: MapRef,
}

impl Default for NoteDoc {
    fn default() -> Self {
        Self::new()
    }
}

impl NoteDoc {
    pub fn new() -> Self {
        // Offsets count UTF-16 code units, matching Yjs and Swift/Kotlin strings.
        let doc = Doc::with_options(Options { offset_kind: OffsetKind::Utf16, ..Options::default() });
        let body = doc.get_or_insert_text("body");
        let meta = doc.get_or_insert_map("meta");
        let tags = doc.get_or_insert_map("tags");
        NoteDoc { doc, body, meta, tags }
    }

    pub fn doc(&self) -> &Doc {
        &self.doc
    }

    pub fn apply_remote(&self, update: &[u8]) -> Result<(), String> {
        let update = Update::decode_v1(update).map_err(|e| e.to_string())?;
        let mut txn = self.doc.transact_mut_with(Origin::from(REMOTE_ORIGIN));
        txn.apply_update(update).map_err(|e| e.to_string())
    }

    pub fn state_vector(&self) -> StateVector {
        self.doc.transact().state_vector()
    }

    pub fn encode_state(&self) -> Vec<u8> {
        self.doc.transact().encode_state_as_update_v1(&StateVector::default())
    }

    pub fn encode_diff(&self, remote: &StateVector) -> Vec<u8> {
        self.doc.transact().encode_state_as_update_v1(remote)
    }

    pub fn body(&self) -> String {
        self.body.get_string(&self.doc.transact())
    }

    pub fn tags(&self) -> Vec<String> {
        let txn = self.doc.transact();
        let mut tags: Vec<String> = self.tags.keys(&txn).map(str::to_owned).collect();
        tags.sort();
        tags
    }

    fn meta_number(&self, txn: &impl ReadTxn, key: &str) -> Option<i64> {
        match self.meta.get(txn, key) {
            Some(Out::Any(Any::Number(n))) => n.as_f64().map(|f| f as i64),
            _ => None,
        }
    }

    pub fn created_at(&self) -> Option<i64> {
        self.meta_number(&self.doc.transact(), "createdAt")
    }

    pub fn updated_at(&self) -> Option<i64> {
        self.meta_number(&self.doc.transact(), "updatedAt")
    }

    pub fn is_deleted(&self) -> bool {
        matches!(self.meta.get(&self.doc.transact(), "deleted"), Some(Out::Any(Any::Bool(true))))
    }

    /// Runs a local edit and stamps the update time, as the web client does.
    fn edit(&self, f: impl FnOnce(&mut TransactionMut)) {
        let mut txn = self.doc.transact_mut();
        f(&mut txn);
        self.meta.insert(&mut txn, "updatedAt", timestamp(now_ms()));
    }

    /// Sets up a brand-new note.
    pub fn initialize(&self) {
        let now = now_ms();
        let mut txn = self.doc.transact_mut();
        self.meta.insert(&mut txn, "createdAt", timestamp(now));
        self.meta.insert(&mut txn, "updatedAt", timestamp(now));
    }

    /// Replaces the body by editing only the span that differs, so concurrent
    /// edits elsewhere in the text merge cleanly. Reading and writing happen in
    /// one transaction, so a change arriving meanwhile cannot shift the span.
    pub fn set_body(&self, new: &str) {
        let mut txn = self.doc.transact_mut();
        let old = self.body.get_string(&txn);
        let Some((start, removed, inserted)) = differing_span(&old, new) else { return };
        if removed > 0 {
            self.body.remove_range(&mut txn, start, removed);
        }
        if !inserted.is_empty() {
            self.body.insert(&mut txn, start, &inserted);
        }
        self.meta.insert(&mut txn, "updatedAt", timestamp(now_ms()));
    }

    /// Replaces `delete` UTF-16 units at `start` with `insert`, as reported by
    /// a text view. Out-of-range positions are clamped.
    pub fn edit_body(&self, start: u32, delete: u32, insert: &str) {
        if delete == 0 && insert.is_empty() {
            return;
        }
        self.edit(|txn| {
            let len = self.body.len(txn);
            let start = start.min(len);
            let delete = delete.min(len - start);
            if delete > 0 {
                self.body.remove_range(txn, start, delete);
            }
            if !insert.is_empty() {
                self.body.insert(txn, start, insert);
            }
        });
    }

    pub fn add_tag(&self, raw: &str) -> bool {
        let tag = normalize_tag(raw);
        if tag.is_empty() || self.tags().contains(&tag) {
            return false;
        }
        self.edit(|txn| {
            self.tags.insert(txn, tag, Any::Bool(true));
        });
        true
    }

    pub fn remove_tag(&self, tag: &str) {
        if !self.tags().iter().any(|t| t == tag) {
            return;
        }
        self.edit(|txn| {
            self.tags.remove(txn, tag);
        });
    }

    pub fn set_deleted(&self, deleted: bool) {
        let mut txn = self.doc.transact_mut();
        self.meta.insert(&mut txn, "deleted", Any::Bool(deleted));
    }

    /// Brings back a version's body and tags as an ordinary edit. The new
    /// `restoredAt` mark makes the server start a fresh history version, so the
    /// content being replaced is kept.
    pub fn restore(&self, body: &str, tags: &[String]) {
        self.set_body(body);
        let current = self.tags();
        let now = now_ms();
        let mut txn = self.doc.transact_mut();
        for t in current.iter().filter(|t| !tags.contains(t)) {
            self.tags.remove(&mut txn, t);
        }
        for t in tags.iter().filter(|t| !current.contains(t)) {
            self.tags.insert(&mut txn, t.clone(), Any::Bool(true));
        }
        self.meta.insert(&mut txn, "restoredAt", timestamp(now));
        self.meta.insert(&mut txn, "updatedAt", timestamp(now));
    }

    pub fn summary(&self, id: &str) -> NoteSummary {
        let body = self.body();
        let lines: Vec<&str> = body.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let txn = self.doc.transact();
        NoteSummary {
            id: id.to_owned(),
            title: lines.first().map(|l| l.chars().take(200).collect()).unwrap_or_default(),
            preview: lines.iter().skip(1).copied().collect::<Vec<_>>().join(" ").chars().take(200).collect(),
            tags: {
                let mut t: Vec<String> = self.tags.keys(&txn).map(str::to_owned).collect();
                t.sort();
                t
            },
            created_at: self.meta_number(&txn, "createdAt").unwrap_or(0),
            updated_at: self.meta_number(&txn, "updatedAt").unwrap_or(0),
            deleted: matches!(self.meta.get(&txn, "deleted"), Some(Out::Any(Any::Bool(true)))),
        }
    }

    /// The meta map as JSON, for debugging and tests.
    pub fn meta_json(&self) -> String {
        let txn = self.doc.transact();
        let mut s = String::new();
        self.meta.to_json(&txn).to_json(&mut s);
        s
    }
}

/// The single span where `old` and `new` differ, in UTF-16 units:
/// `(start, removed length, inserted text)`. `None` when they are equal.
/// The span never splits a surrogate pair.
pub fn differing_span(old: &str, new: &str) -> Option<(u32, u32, String)> {
    if old == new {
        return None;
    }
    let a: Vec<u16> = old.encode_utf16().collect();
    let b: Vec<u16> = new.encode_utf16().collect();
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    if start > 0 && is_low_surrogate(a.get(start).copied().or(b.get(start).copied())) {
        start -= 1;
    }
    let mut end = 0;
    while end < a.len() - start && end < b.len() - start && a[a.len() - 1 - end] == b[b.len() - 1 - end] {
        end += 1;
    }
    if end > 0 && is_low_surrogate(a.get(a.len() - end).copied()) {
        end -= 1;
    }
    let inserted = String::from_utf16_lossy(&b[start..b.len() - end]);
    Some((start as u32, (a.len() - end - start) as u32, inserted))
}

fn is_low_surrogate(unit: Option<u16>) -> bool {
    matches!(unit, Some(0xDC00..=0xDFFF))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn differing_span_cases() {
        assert_eq!(differing_span("abc", "abc"), None);
        assert_eq!(differing_span("abc", "abXc"), Some((2, 0, "X".into())));
        assert_eq!(differing_span("abc", "ac"), Some((1, 1, String::new())));
        assert_eq!(differing_span("", "日本"), Some((0, 0, "日本".into())));
        // "😀" and "😃" share the high surrogate; the span must cover both units.
        assert_eq!(differing_span("a😀b", "a😃b"), Some((1, 2, "😃".into())));
        // Appending an identical emoji: the inserted span is whole, wherever it is placed.
        let (start, removed, inserted) = differing_span("😀", "😀😀").unwrap();
        assert_eq!((removed, inserted.as_str()), (0, "😀"));
        assert!(start == 0 || start == 2);
    }

    #[test]
    fn edits_merge_between_two_docs() {
        let a = NoteDoc::new();
        a.initialize();
        a.set_body("Title\nhello");
        let b = NoteDoc::new();
        b.apply_remote(&a.encode_state()).unwrap();

        a.set_body("Title from A\nhello");
        b.set_body("Title\nhello world 😀");
        let from_a = a.encode_diff(&b.state_vector());
        let from_b = b.encode_diff(&a.state_vector());
        a.apply_remote(&from_b).unwrap();
        b.apply_remote(&from_a).unwrap();
        assert_eq!(a.body(), "Title from A\nhello world 😀");
        assert_eq!(a.body(), b.body());
    }

    #[test]
    fn tags_trash_restore_and_summary() {
        let n = NoteDoc::new();
        n.initialize();
        n.set_body("  First line \n\n second\nthird ");
        assert!(n.add_tag(" work  items "));
        assert!(!n.add_tag("work-items"));
        n.add_tag("home");
        n.remove_tag("home");
        let s = n.summary("x");
        assert_eq!(s.title, "First line");
        assert_eq!(s.preview, "second third");
        assert_eq!(s.tags, vec!["work-items"]);
        assert!(s.created_at > 0);

        n.edit_body(0, 2, "X");
        assert!(n.body().starts_with("XFirst"));
        n.edit_body(1000, 5, "!");
        assert!(n.body().ends_with("third !"));
        n.set_deleted(true);
        assert!(n.is_deleted());
        n.restore("old body", &["a".into()]);
        assert_eq!(n.body(), "old body");
        assert_eq!(n.tags(), vec!["a"]);
        assert!(n.meta_json().contains("restoredAt"));
    }
}
