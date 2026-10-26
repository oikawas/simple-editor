import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { NoteSummary } from "./note.js";

interface NoteRow {
  id: string;
  title: string;
  preview: string;
  tags: string;
  created_at: number;
  updated_at: number;
  deleted: number;
}

export interface SearchHit {
  id: string;
  snippet: string;
}

export function splitTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 10);
}

// A one-line excerpt starting just before the first term found in the body,
// so the match stays visible when the client truncates it.
export function snippet(body: string, terms: string[], before = 12, after = 100): string {
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    at = lower.indexOf(t.toLowerCase());
    if (at >= 0) break;
  }
  if (at < 0) at = 0;
  const start = Math.max(0, at - before);
  const end = Math.min(body.length, at + after);
  const text = body.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + text + (end < body.length ? "…" : "");
}

export interface VersionInfo {
  id: number;
  savedAt: number;
  title: string;
  length: number;
}

export interface Version {
  id: number;
  savedAt: number;
  body: string;
  tags: string[];
}

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

interface DeviceRow {
  id: string;
  name: string;
  created_at: number;
  last_seen_at: number;
}

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  name: r.name,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

export class Store {
  private db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "notes.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        name TEXT PRIMARY KEY,
        state BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        preview TEXT NOT NULL,
        tags TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      -- Full-text index over note bodies and tags. The trigram tokenizer
      -- matches substrings, so it works for Japanese without word splitting.
      -- Snapshots of each note's body and tags, newest last.
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        saved_at INTEGER NOT NULL,
        body TEXT NOT NULL,
        tags TEXT NOT NULL,
        restore_mark INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS versions_note ON versions (note_id, id);
      -- Registered devices. Only a hash of each device's token is kept.
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
        id UNINDEXED, body, tags, tokenize = 'trigram'
      );
    `);
  }

  isSearchIndexEmpty(): boolean {
    return this.db.prepare("SELECT 1 FROM notes_fts LIMIT 1").get() === undefined;
  }

  listDocumentNames(): string[] {
    return (this.db.prepare("SELECT name FROM documents").all() as { name: string }[]).map((r) => r.name);
  }

  indexBody(id: string, body: string, tags: string[]): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM notes_fts WHERE id = ?").run(id);
      this.db.prepare("INSERT INTO notes_fts (id, body, tags) VALUES (?, ?, ?)").run(id, body, tags.join(" "));
    })();
  }

  // Every whitespace-separated term must appear in the body or tags (case-insensitive).
  // Terms of 3+ characters use the trigram index; shorter ones fall back to a scan,
  // which is fine at personal-notes scale.
  search(query: string, limit = 200): SearchHit[] {
    const terms = splitTerms(query);
    if (terms.length === 0) return [];
    const long = terms.filter((t) => [...t].length >= 3);
    const short = terms.filter((t) => [...t].length < 3);
    const where: string[] = [];
    const params: string[] = [];
    if (long.length) {
      where.push("notes_fts MATCH ?");
      params.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND "));
    }
    for (const t of short) {
      where.push("(instr(lower(f.body), lower(?)) > 0 OR instr(lower(f.tags), lower(?)) > 0)");
      params.push(t, t);
    }
    const rows = this.db
      .prepare(
        `SELECT f.id AS id, f.body AS body FROM notes_fts f JOIN notes n ON n.id = f.id
         WHERE ${where.join(" AND ")} ORDER BY n.updated_at DESC LIMIT ${Number(limit)}`,
      )
      .all(...params) as { id: string; body: string }[];
    return rows.map((r) => ({ id: r.id, snippet: snippet(r.body, terms) }));
  }

  loadState(name: string): Uint8Array | null {
    const row = this.db.prepare("SELECT state FROM documents WHERE name = ?").get(name) as
      | { state: Buffer }
      | undefined;
    return row ? new Uint8Array(row.state) : null;
  }

  saveState(name: string, state: Uint8Array): void {
    this.db
      .prepare("INSERT INTO documents (name, state) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET state = excluded.state")
      .run(name, Buffer.from(state));
  }

  // created_at is kept from the first time the note was seen and never overwritten.
  upsertNote(note: NoteSummary): void {
    this.db
      .prepare(
        `INSERT INTO notes (id, title, preview, tags, created_at, updated_at, deleted)
         VALUES (@id, @title, @preview, @tags, @createdAt, @updatedAt, @deleted)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           preview = excluded.preview,
           tags = excluded.tags,
           updated_at = excluded.updated_at,
           deleted = excluded.deleted`,
      )
      .run({ ...note, tags: JSON.stringify(note.tags), deleted: note.deleted ? 1 : 0 });
  }

  getNote(id: string): NoteSummary | null {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
    return row ? toSummary(row) : null;
  }

  listNotes(): NoteSummary[] {
    const rows = this.db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all() as NoteRow[];
    return rows.map(toSummary);
  }

  // Records the note's content as a version. Saves within `intervalMs` of the
  // latest version's start update that version instead of adding one, so a
  // burst of typing becomes a single entry. Unchanged content is skipped.
  // A new `restoreMark` (set by the client when it restores a version) always
  // starts a new version, so the content from before the restore is kept.
  recordVersion(
    noteId: string,
    body: string,
    tags: string[],
    now: number,
    intervalMs: number,
    restoreMark = 0,
  ): void {
    const tagsJson = JSON.stringify(tags);
    const latest = this.db
      .prepare(
        "SELECT id, started_at, body, tags, restore_mark FROM versions WHERE note_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(noteId) as
      | { id: number; started_at: number; body: string; tags: string; restore_mark: number }
      | undefined;
    if (latest && latest.body === body && latest.tags === tagsJson) return;
    if (latest && now - latest.started_at < intervalMs && latest.restore_mark === restoreMark) {
      this.db
        .prepare("UPDATE versions SET saved_at = ?, body = ?, tags = ? WHERE id = ?")
        .run(now, body, tagsJson, latest.id);
    } else {
      this.db
        .prepare(
          "INSERT INTO versions (note_id, started_at, saved_at, body, tags, restore_mark) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(noteId, now, now, body, tagsJson, restoreMark);
    }
  }

  hasVersions(noteId: string): boolean {
    return this.db.prepare("SELECT 1 FROM versions WHERE note_id = ? LIMIT 1").get(noteId) !== undefined;
  }

  listVersions(noteId: string): VersionInfo[] {
    const rows = this.db
      .prepare("SELECT id, saved_at, body FROM versions WHERE note_id = ? ORDER BY id DESC")
      .all(noteId) as { id: number; saved_at: number; body: string }[];
    return rows.map((r) => ({
      id: r.id,
      savedAt: r.saved_at,
      title: (r.body.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 200),
      length: r.body.length,
    }));
  }

  getVersion(noteId: string, versionId: number): Version | null {
    const row = this.db
      .prepare("SELECT id, saved_at, body, tags FROM versions WHERE note_id = ? AND id = ?")
      .get(noteId, versionId) as { id: number; saved_at: number; body: string; tags: string } | undefined;
    return row ? { id: row.id, savedAt: row.saved_at, body: row.body, tags: JSON.parse(row.tags) } : null;
  }

  createDevice(id: string, name: string, tokenHash: string, now: number): Device {
    this.db
      .prepare("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, tokenHash, now, now);
    return { id, name, createdAt: now, lastSeenAt: now };
  }

  findDeviceByTokenHash(tokenHash: string): Device | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(tokenHash) as DeviceRow | undefined;
    return row ? toDevice(row) : null;
  }

  listDevices(): Device[] {
    const rows = this.db.prepare("SELECT * FROM devices ORDER BY created_at").all() as DeviceRow[];
    return rows.map(toDevice);
  }

  renameDevice(id: string, name: string): void {
    this.db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name, id);
  }

  touchDevice(id: string, now: number): void {
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, id);
  }

  deleteDevice(id: string): boolean {
    return this.db.prepare("DELETE FROM devices WHERE id = ?").run(id).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

function toSummary(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    preview: row.preview,
    tags: JSON.parse(row.tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: row.deleted === 1,
  };
}
