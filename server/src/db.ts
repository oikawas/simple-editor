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
    `);
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
