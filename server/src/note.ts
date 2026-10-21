import * as Y from "yjs";

// Shape of a note document (shared with the client):
//   getText("body")  - note content
//   getMap("meta")   - { createdAt: number, updatedAt: number, deleted: boolean }
//   getMap("tags")   - tag name -> true (map gives set semantics that merge cleanly)

export const NOTE_PREFIX = "note:";
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
