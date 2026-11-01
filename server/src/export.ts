import JSZip from "jszip";
import { diaryDate, type NoteSummary } from "./note.js";

export interface ExportEntry {
  note: NoteSummary;
  body: string;
}

// Diary entries are named by date and, in a zip, filed by year and month
// (diary/2024/01/2024-01-02.txt); notes are named by title.
export function fileNameFor(note: NoteSummary, used: Set<string>, inFolders = false): string {
  const date = diaryDate(note.id);
  if (date) {
    const name = inFolders ? `diary/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.txt` : `${date}.txt`;
    used.add(name.toLowerCase());
    return name;
  }
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
// so nothing is lost when the bodies are exported as bare text. Diary days
// with nothing written are left out.
export async function buildZip(entries: ExportEntry[]): Promise<Buffer> {
  const zip = new JSZip();
  const used = new Set<string>(["notes.json"]);
  const index = [];
  for (const { note, body } of entries) {
    const date = diaryDate(note.id);
    if (date && !body.trim()) continue;
    const file = fileNameFor(note, used, true);
    zip.file(file, body, { date: new Date(note.updatedAt) });
    index.push({
      file,
      id: note.id,
      title: note.title,
      ...(date ? { diary: date } : {}),
      tags: note.tags,
      createdAt: new Date(note.createdAt).toISOString(),
      updatedAt: new Date(note.updatedAt).toISOString(),
    });
  }
  zip.file("notes.json", JSON.stringify(index, null, 2) + "\n");
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
