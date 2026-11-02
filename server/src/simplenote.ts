import crypto from "node:crypto";
import JSZip from "jszip";
import * as Y from "yjs";

// Import of a Simplenote export: the notes.zip it produces (the notes are in
// source/notes.json) or that notes.json on its own. Only the notes in
// activeNotes are imported; trashed notes are left out.

export interface SimplenoteNote {
  id: string;
  content: string;
  creationDate?: string | number;
  lastModified?: string | number;
  tags?: unknown;
}

export class ImportFormatError extends Error {}

export async function readSimplenoteExport(data: Buffer): Promise<SimplenoteNote[]> {
  const parsed = isZip(data) ? await notesJsonFromZip(data) : parseJson(data.toString("utf8"));
  if (!parsed) throw new ImportFormatError("not a Simplenote export");
  return parsed.filter(
    (n): n is SimplenoteNote => !!n && typeof n.id === "string" && n.id.length > 0 && typeof n.content === "string",
  );
}

function isZip(data: Buffer): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b;
}

function parseJson(text: string): any[] | null {
  try {
    const json = JSON.parse(text.replace(/^﻿/, ""));
    return Array.isArray(json?.activeNotes) ? json.activeNotes : null;
  } catch {
    return null;
  }
}

async function notesJsonFromZip(data: Buffer): Promise<any[] | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new ImportFormatError("broken zip");
  }
  // source/notes.json in the export; any other notes.json is tried as well.
  const files = zip.file(/(^|\/)notes\.json$/).sort((a, b) => a.name.length - b.name.length);
  for (const file of files) {
    const notes = parseJson(await file.async("string"));
    if (notes) return notes;
  }
  return null;
}

// The id an imported note gets. It follows from the Simplenote id, so importing
// the same export again finds the notes it already made.
export function noteIdFor(simplenoteId: string): string {
  if (/^[A-Za-z0-9-]{1,61}$/.test(simplenoteId)) return `sn-${simplenoteId}`;
  return `sn-${crypto.createHash("sha256").update(simplenoteId).digest("hex").slice(0, 32)}`;
}

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

// A date written alone on the last non-empty line, as "2024/01/02" or "2024/1/2".
export function lastLineDate(content: string): CalendarDate | null {
  const last = content
    .split(/\r\n?|\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .pop();
  const m = last ? /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(last) : null;
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

export function validTimeZone(tz: string | null): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

// The instant the given day starts in the time zone.
export function startOfDay(date: CalendarDate, timeZone: string): number {
  const target = Date.UTC(date.year, date.month - 1, date.day);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (shown === target) break;
    guess += target - shown;
  }
  return guess;
}

function toMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

// The creation date: the date on the last line when there is one (keeping
// Simplenote's time of day if it was created that same day), otherwise
// Simplenote's own creation date.
export function creationTime(note: SimplenoteNote, timeZone: string, now: number): number {
  const created = toMillis(note.creationDate);
  const date = lastLineDate(note.content);
  if (date) {
    if (created !== null) {
      const p = zonedParts(created, timeZone);
      if (p.year === date.year && p.month === date.month && p.day === date.day) return created;
    }
    return startOfDay(date, timeZone);
  }
  return created ?? toMillis(note.lastModified) ?? now;
}

// Same rule as the clients' normalizeTag.
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, "-").slice(0, 64);
}

// A note document (see note.ts) holding the Simplenote note.
export function buildNoteDoc(note: SimplenoteNote, timeZone: string, now: number): Y.Doc {
  const doc = new Y.Doc();
  const createdAt = creationTime(note, timeZone, now);
  const updatedAt = toMillis(note.lastModified) ?? createdAt;
  doc.transact(() => {
    doc.getText("body").insert(0, note.content.replace(/\r\n?/g, "\n"));
    const meta = doc.getMap("meta");
    meta.set("createdAt", createdAt);
    meta.set("updatedAt", Math.max(updatedAt, createdAt));
    const tags = doc.getMap("tags");
    for (const raw of Array.isArray(note.tags) ? note.tags : []) {
      if (typeof raw !== "string") continue;
      const tag = normalizeTag(raw);
      if (tag) tags.set(tag, true);
    }
  });
  return doc;
}
