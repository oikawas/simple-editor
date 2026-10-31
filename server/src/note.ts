import * as Y from "yjs";

// Shape of a note document (shared with the client):
//   getText("body")  - note content
//   getMap("meta")   - { createdAt: number, updatedAt: number, deleted: boolean,
//                        restoredAt: number (set when a version is restored) }
//   getMap("tags")   - tag name -> true (map gives set semantics that merge cleanly)

export const NOTE_PREFIX = "note:";
// A diary entry is the note "diary-YYYY-MM-DD". The id follows from the date,
// so entries written for the same day on several devices are one document.
export const DIARY_PREFIX = "diary-";
export const INDEX_DOC = "__index";

export interface NoteSummary {
  id: string;
  title: string;
  preview: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

export function noteIdFromDocName(name: string): string | null {
  if (!name.startsWith(NOTE_PREFIX)) return null;
  const id = name.slice(NOTE_PREFIX.length);
  return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
}

// The date ("YYYY-MM-DD") of a diary entry's id, or null for an ordinary note.
export function diaryDate(id: string): string | null {
  const m = /^diary-(\d{4})-(\d{2})-(\d{2})$/.exec(id);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function summarize(
  doc: Y.Doc,
): Omit<NoteSummary, "id" | "createdAt" | "updatedAt"> & { createdAt: number | null; updatedAt: number | null } {
  const body = doc.getText("body").toString();
  const meta = doc.getMap("meta");
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const createdAt = meta.get("createdAt");
  const updatedAt = meta.get("updatedAt");
  return {
    title: (lines[0] ?? "").slice(0, 200),
    preview: lines.slice(1).join(" ").slice(0, 200),
    tags: [...doc.getMap("tags").keys()].sort(),
    createdAt: typeof createdAt === "number" ? createdAt : null,
    updatedAt: typeof updatedAt === "number" ? updatedAt : null,
    deleted: meta.get("deleted") === true,
  };
}

export function bodyOf(doc: Y.Doc): string {
  return doc.getText("body").toString();
}

export function restoreMarkOf(doc: Y.Doc): number {
  const mark = doc.getMap("meta").get("restoredAt");
  return typeof mark === "number" ? mark : 0;
}
