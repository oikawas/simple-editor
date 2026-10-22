import * as Y from "yjs";

export interface VersionInfo {
  id: number;
  savedAt: number;
  title: string;
  length: number;
}

export interface Version {
  id: number;
  savedAt: number;
  body: string;
  tags: string[];
}

export type DiffLine = { kind: "same" | "add" | "remove"; text: string };

// Line diff from `from` to `to` using a longest-common-subsequence table.
// Returns null when the texts are too large to diff quickly.
export function lineDiff(from: string, to: string, maxCells = 4_000_000): DiffLine[] | null {
  const a = from.split("\n");
  const b = to.split("\n");
  // Trim the common head and tail first; most edits touch a small region.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const n = am.length;
  const m = bm.length;
  if ((n + 1) * (m + 1) > maxCells) return null;

  const lcs = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[at(i, j)] = am[i] === bm[j] ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
    }
  }
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      middle.push({ kind: "same", text: am[i] });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[at(i, j + 1)] >= lcs[at(i + 1, j)])) {
      middle.push({ kind: "add", text: bm[j++] });
    } else {
      middle.push({ kind: "remove", text: am[i++] });
    }
  }
  const same = (text: string): DiffLine => ({ kind: "same", text });
  return [...a.slice(0, head).map(same), ...middle, ...a.slice(a.length - tail).map(same)];
}

// Replaces the note's body and tags with a version's, as an ordinary edit:
// it syncs and merges like typing, and the server keeps the replaced content
// as its own version (the restoredAt mark makes it start a new one).
export function restoreVersion(doc: Y.Doc, version: Version): void {
  const body = doc.getText("body");
  const tags = doc.getMap<boolean>("tags");
  const meta = doc.getMap("meta");
  doc.transact(() => {
    const current = body.toString();
    const target = version.body;
    // Only replace the part that differs, so remote cursors elsewhere stay put.
    let start = 0;
    while (start < current.length && start < target.length && current[start] === target[start]) start++;
    let end = 0;
    while (
      end < current.length - start &&
      end < target.length - start &&
      current[current.length - 1 - end] === target[target.length - 1 - end]
    )
      end++;
    body.delete(start, current.length - start - end);
    body.insert(start, target.slice(start, target.length - end));

    const wanted = new Set(version.tags);
    for (const t of [...tags.keys()]) if (!wanted.has(t)) tags.delete(t);
    for (const t of wanted) if (!tags.has(t)) tags.set(t, true);

    const now = Date.now();
    meta.set("restoredAt", now);
    meta.set("updatedAt", now);
  });
}
