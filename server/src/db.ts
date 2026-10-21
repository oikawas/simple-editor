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
