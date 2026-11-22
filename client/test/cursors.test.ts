import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_LIMIT, loadCursor, saveCursor } from "../src/cursors.ts";

function memoryStore() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

test("returns the saved cursor", () => {
  const store = memoryStore();
  assert.equal(loadCursor("a", 100, store), null);
  saveCursor("a", { anchor: 12, head: 20 }, store);
  assert.deepEqual(loadCursor("a", 100, store), { anchor: 12, head: 20 });
});

test("fits the cursor to a shorter text", () => {
  const store = memoryStore();
  saveCursor("a", { anchor: 50, head: 80 }, store);
  assert.deepEqual(loadCursor("a", 60, store), { anchor: 50, head: 60 });
});

test("a cursor at the start is not kept", () => {
  const store = memoryStore();
  saveCursor("a", { anchor: 5, head: 5 }, store);
  saveCursor("a", { anchor: 0, head: 0 }, store);
  assert.equal(loadCursor("a", 10, store), null);
  assert.equal(store.getItem("simple-editor:cursors"), "{}");
});

test("drops the oldest cursors beyond the limit", () => {
  const store = memoryStore();
  for (let i = 0; i <= CURSOR_LIMIT; i++) saveCursor(`n${i}`, { anchor: 1, head: 1 }, store, i);
  assert.equal(loadCursor("n0", 10, store), null);
  assert.deepEqual(loadCursor("n1", 10, store), { anchor: 1, head: 1 });
  assert.deepEqual(loadCursor(`n${CURSOR_LIMIT}`, 10, store), { anchor: 1, head: 1 });
});

test("ignores broken data", () => {
  const store = memoryStore();
  store.setItem("simple-editor:cursors", "not json");
  assert.equal(loadCursor("a", 10, store), null);
  saveCursor("a", { anchor: 3, head: 3 }, store);
  assert.deepEqual(loadCursor("a", 10, store), { anchor: 3, head: 3 });
});
