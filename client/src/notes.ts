import * as Y from "yjs";

// Must stay in sync with server/src/note.ts.
export interface NoteSummary {
  id: string;
  title: string;
  preview: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
}

export const docName = (id: string) => `note:${id}`;

export function summarize(id: string, doc: Y.Doc): NoteSummary {
  const lines = doc
    .getText("body")
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const meta = doc.getMap("meta");
  return {
    id,
    title: (lines[0] ?? "").slice(0, 200),
    preview: lines.slice(1).join(" ").slice(0, 200),
    tags: [...doc.getMap("tags").keys()].sort(),
    createdAt: (meta.get("createdAt") as number) ?? Date.now(),
    updatedAt: (meta.get("updatedAt") as number) ?? Date.now(),
    deleted: meta.get("deleted") === true,
  };
}

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, "-").slice(0, 64);
}

export function newId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
