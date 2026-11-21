// Where the cursor was in each note when it was last left, kept per device so
// a note opens where the user stopped. Offsets are in UTF-16 code units, as
// CodeMirror counts them.

export interface Cursor {
  anchor: number;
  head: number;
}

interface Entry extends Cursor {
  /** When the cursor was saved (ms), to drop the oldest entries first. */
  at: number;
}

/** How many notes' cursors are kept; the oldest are dropped beyond this. */
export const CURSOR_LIMIT = 500;
const KEY = "simple-editor:cursors";

type Store = Pick<Storage, "getItem" | "setItem">;

function read(store: Store): Record<string, Entry> {
  try {
    const parsed = JSON.parse(store.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The saved cursor of a note, fitted to a text of `length` units. */
export function loadCursor(id: string, length: number, store: Store = localStorage): Cursor | null {
  const e = read(store)[id];
  if (!e || !Number.isInteger(e.anchor) || !Number.isInteger(e.head)) return null;
  const fit = (n: number) => Math.max(0, Math.min(n, length));
  return { anchor: fit(e.anchor), head: fit(e.head) };
}

/** Saves a note's cursor. A cursor at the start is the default and is not kept. */
export function saveCursor(id: string, cursor: Cursor, store: Store = localStorage, now = Date.now()): void {
  const all = read(store);
  if (cursor.anchor === 0 && cursor.head === 0) {
    if (!(id in all)) return;
    delete all[id];
  } else {
    all[id] = { anchor: cursor.anchor, head: cursor.head, at: now };
  }
  const ids = Object.keys(all);
  if (ids.length > CURSOR_LIMIT) {
    ids.sort((a, b) => all[b].at - all[a].at);
    for (const old of ids.slice(CURSOR_LIMIT)) delete all[old];
  }
  try {
    store.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage full or unavailable: the cursor is simply not remembered.
  }
}
