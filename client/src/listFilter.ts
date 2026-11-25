// Narrowing the notes list by when a note was created and by tags to leave
// out. The tags to leave out are kept per device; the year and month are not.

import type { NoteSummary } from "./notes";

export interface CreatedFilter {
  /** A year such as 2025, or null for any year. */
  year: number | null;
  /** 1 to 12, or null for any month. */
  month: number | null;
}

/** Whether a note was created in the year and month, in local time. */
export function createdIn(createdAt: number, f: CreatedFilter): boolean {
  if (f.year === null && f.month === null) return true;
  if (!createdAt) return false;
  const d = new Date(createdAt);
  return (f.year === null || d.getFullYear() === f.year) && (f.month === null || d.getMonth() + 1 === f.month);
}

/** Whether a note has none of the tags to leave out. */
export function withoutExcluded(note: Pick<NoteSummary, "tags">, excluded: readonly string[]): boolean {
  return !note.tags.some((t) => excluded.includes(t));
}

/** The years notes were created in, newest first. */
export function createdYears(notes: Iterable<Pick<NoteSummary, "createdAt">>): number[] {
  const years = new Set<number>();
  for (const n of notes) if (n.createdAt) years.add(new Date(n.createdAt).getFullYear());
  return [...years].sort((a, b) => b - a);
}

const KEY = "simple-editor:excluded-tags";
type Store = Pick<Storage, "getItem" | "setItem">;

export function loadExcludedTags(store: Store = localStorage): string[] {
  try {
    const parsed = JSON.parse(store.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function saveExcludedTags(tags: readonly string[], store: Store = localStorage): void {
  try {
    store.setItem(KEY, JSON.stringify([...new Set(tags)].sort()));
  } catch {
    // Storage full or unavailable: the choice lasts until the page is closed.
  }
}
