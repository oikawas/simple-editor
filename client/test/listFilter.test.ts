import assert from "node:assert/strict";
import { test } from "node:test";
import { createdIn, createdYears, loadExcludedTags, saveExcludedTags, withoutExcluded } from "../src/listFilter.ts";

function memoryStore() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
}

const at = (y: number, m: number, d = 15) => new Date(y, m - 1, d, 12).getTime();

test("matches the creation year and month in local time", () => {
  assert.ok(createdIn(at(2025, 11), { year: null, month: null }));
  assert.ok(createdIn(at(2025, 11), { year: 2025, month: null }));
  assert.ok(createdIn(at(2025, 11), { year: null, month: 11 }));
  assert.ok(createdIn(at(2025, 11), { year: 2025, month: 11 }));
  assert.ok(!createdIn(at(2025, 11), { year: 2024, month: null }));
  assert.ok(!createdIn(at(2025, 11), { year: 2025, month: 10 }));
  // The first and last moments of a month, local time.
  assert.ok(createdIn(new Date(2025, 10, 1, 0, 0).getTime(), { year: 2025, month: 11 }));
  assert.ok(createdIn(new Date(2025, 10, 30, 23, 59).getTime(), { year: 2025, month: 11 }));
});

test("a note without a creation time matches only no filter", () => {
  assert.ok(createdIn(0, { year: null, month: null }));
  assert.ok(!createdIn(0, { year: 1970, month: null }));
});

test("leaves out notes with any excluded tag", () => {
  assert.ok(withoutExcluded({ tags: ["work"] }, []));
  assert.ok(withoutExcluded({ tags: ["work"] }, ["archive"]));
  assert.ok(!withoutExcluded({ tags: ["work", "archive"] }, ["archive", "draft"]));
  assert.ok(withoutExcluded({ tags: [] }, ["archive"]));
});

test("lists the years notes were created in, newest first", () => {
  assert.deepEqual(createdYears([{ createdAt: at(2024, 3) }, { createdAt: at(2026, 1) }, { createdAt: at(2024, 9) }, { createdAt: 0 }]), [2026, 2024]);
});

test("keeps the excluded tags", () => {
  const store = memoryStore();
  assert.deepEqual(loadExcludedTags(store), []);
  saveExcludedTags(["draft", "archive", "draft"], store);
  assert.deepEqual(loadExcludedTags(store), ["archive", "draft"]);
  store.setItem("simple-editor:excluded-tags", "not json");
  assert.deepEqual(loadExcludedTags(store), []);
});
