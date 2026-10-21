import JSZip from "jszip";
import type { NoteSummary } from "./note.js";

export interface ExportEntry {
  note: NoteSummary;
  body: string;
}

export function fileNameFor(note: NoteSummary, used: Set<string>): string {
  const base =
    note.title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 80) || "untitled";
  let name = `${base}.txt`;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i}).txt`;
  used.add(name.toLowerCase());
  return name;
}

// One plain-text file per note, plus notes.json carrying tags and dates
// so nothing is lost when the bodies are exported as bare text.
export async function buildZip(entries: ExportEntry[]): Promise<Buffer> {
  const zip = new JSZip();
  const used = new Set<string>(["notes.json"]);
  const index = [];
  for (const { note, body } of entries) {
    const file = fileNameFor(note, used);
    zip.file(file, body, { date: new Date(note.updatedAt) });
    index.push({
      file,
      id: note.id,
      title: note.title,
      tags: note.tags,
      createdAt: new Date(note.createdAt).toISOString(),
      updatedAt: new Date(note.updatedAt).toISOString(),
    });
  }
  zip.file("notes.json", JSON.stringify(index, null, 2) + "\n");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
