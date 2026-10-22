import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import JSZip from "jszip";
import * as Y from "yjs";
import { createApp } from "../src/app.js";
import { Store } from "../src/db.js";

const TOKEN = "test-token-0123456789";
let dataDir: string;
let app: ReturnType<typeof createApp>;
let base: string;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-editor-"));
  app = createApp({ port: 0, dataDir, authToken: TOKEN, staticDir: null, historyIntervalMs: 0 });
  await app.server.listen(0);
  base = `127.0.0.1:${app.server.address.port}`;
});

after(async () => {
  await app.server.destroy();
  app.store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function connect(name: string, token = TOKEN) {
  const doc = new Y.Doc();
  const websocketProvider = new HocuspocusProviderWebsocket({ url: `ws://${base}` });
  const provider = new HocuspocusProvider({ name, document: doc, token, websocketProvider });
  const synced = new Promise<void>((resolve, reject) => {
    provider.on("synced", () => resolve());
    provider.on("authenticationFailed", () => reject(new Error("auth failed")));
  });
  provider.attach();
  const close = () => {
    provider.destroy();
    websocketProvider.destroy();
  };
  return { doc, provider, websocketProvider, synced, close };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out");
}

function api(p: string, token = TOKEN) {
  return fetch(`http://${base}${p}`, { headers: { Authorization: `Bearer ${token}` } });
}

test("rejects a wrong token", async () => {
  const c = connect("note:abc", "wrong-token-xxxxxxxx");
  await assert.rejects(c.synced);
  c.close();
  assert.equal((await api("/api/notes", "nope")).status, 401);
});

test("concurrent edits from two clients converge and persist", async () => {
  const a = connect("note:n1");
  const b = connect("note:n1");
  await Promise.all([a.synced, b.synced]);

  a.doc.transact(() => {
    a.doc.getMap("meta").set("createdAt", Date.UTC(2024, 0, 2));
    a.doc.getText("body").insert(0, "Title\nhello");
  });
  await until(() => b.doc.getText("body").toString() === "Title\nhello");

  // Both clients edit at the same moment, including while one is offline.
  b.websocketProvider.disconnect();
  await until(() => b.websocketProvider.status === "disconnected");
  a.doc.getText("body").insert(5, " from A");
  b.doc.getText("body").insert(b.doc.getText("body").length, " world");
  a.doc.getMap("tags").set("work", true);
  b.doc.getMap("tags").set("idea", true);
  await b.websocketProvider.connect();

  const expected = "Title from A\nhello world";
  await until(() => a.doc.getText("body").toString() === expected && b.doc.getText("body").toString() === expected);
  await until(() => a.doc.getMap("tags").size === 2 && b.doc.getMap("tags").size === 2);

  a.close();
  b.close();

  await until(async () => {
    const notes = await (await api("/api/notes")).json();
    return notes[0]?.title === "Title from A" && notes[0]?.tags.length === 2;
  });
  const [note] = await (await api("/api/notes")).json();
  assert.equal(note.id, "n1");
  assert.deepEqual(note.tags, ["idea", "work"]);
  assert.equal(note.createdAt, Date.UTC(2024, 0, 2));
  assert.equal(note.preview, "hello world");

  // A fresh client gets the stored state back.
  const c = connect("note:n1");
  await c.synced;
  assert.equal(c.doc.getText("body").toString(), expected);
  c.close();
});

test("exports notes as text files", async () => {
  const txt = await api("/api/notes/n1.txt");
  assert.equal(txt.status, 200);
  assert.equal(await txt.text(), "Title from A\nhello world");

  const res = await api("/api/export.zip");
  assert.equal(res.headers.get("content-type"), "application/zip");
  const zip = await JSZip.loadAsync(await res.arrayBuffer());
  assert.equal(await zip.file("Title from A.txt")!.async("string"), "Title from A\nhello world");
  const index = JSON.parse(await zip.file("notes.json")!.async("string"));
  assert.equal(index[0].createdAt, "2024-01-02T00:00:00.000Z");
  assert.deepEqual(index[0].tags, ["idea", "work"]);
});

test("full-text search matches body text and tags", async () => {
  const c = connect("note:n2");
  await c.synced;
  c.doc.transact(() => {
    c.doc.getText("body").insert(0, "週末の予定\n図書館で本を返す\nThen buy Coffee beans");
    c.doc.getMap("tags").set("private", true);
  });
  c.close();
  await until(async () => (await (await api("/api/search?q=" + encodeURIComponent("図書館"))).json()).length === 1);

  const search = async (q: string) =>
    ((await (await api("/api/search?q=" + encodeURIComponent(q))).json()) as { id: string; snippet: string }[]);
  const ids = async (q: string) => (await search(q)).map((h) => h.id).sort();

  assert.deepEqual(await ids("図書館"), ["n2"]); // 3+ chars: trigram index
  assert.deepEqual(await ids("本"), ["n2"]); // 1 char: scan
  assert.deepEqual(await ids("hello"), ["n1"]); // body text past the preview
  assert.deepEqual(await ids("COFFEE"), ["n2"]); // case-insensitive
  assert.deepEqual(await ids("coffee 図書館"), ["n2"]); // all terms must match
  assert.deepEqual(await ids("coffee 牛乳"), []);
  assert.deepEqual(await ids("privat"), ["n2"]); // tags
  assert.deepEqual(await ids("\"quoted"), []);
  assert.deepEqual(await ids(""), []);
  assert.match((await search("beans"))[0].snippet, /Coffee beans/);
});

test("history folds edits within the interval and skips unchanged content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-editor-store-"));
  const store = new Store(dir);
  try {
    const min = 60_000;
    store.recordVersion("h", "a", [], 0, 10 * min);
    store.recordVersion("h", "ab", [], 5 * min, 10 * min); // same burst
    store.recordVersion("h", "ab", [], 20 * min, 10 * min); // unchanged
    store.recordVersion("h", "abc", ["t"], 30 * min, 10 * min); // new version
    store.recordVersion("h", "a", [], 31 * min, 10 * min, 1); // restore: new version despite the window
    store.recordVersion("h", "ax", [], 32 * min, 10 * min, 1); // typing after the restore folds in
    const list = store.listVersions("h");
    assert.deepEqual(
      list.map((v) => [v.savedAt, v.title]),
      [
        [32 * min, "ax"],
        [30 * min, "abc"],
        [5 * min, "ab"],
      ],
    );
    assert.deepEqual(store.getVersion("h", list[1].id), { id: list[1].id, savedAt: 30 * min, body: "abc", tags: ["t"] });
    assert.equal(store.getVersion("other", list[0].id), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lists and returns a note's versions", async () => {
  const c = connect("note:h1");
  await c.synced;
  c.doc.getText("body").insert(0, "first draft");
  await until(async () => (await (await api("/api/notes/h1/versions")).json()).length === 1);
  c.doc.transact(() => {
    c.doc.getText("body").insert(0, "Title\n");
    c.doc.getMap("tags").set("x", true);
  });
  await until(async () => (await (await api("/api/notes/h1/versions")).json()).length === 2);
  c.close();

  const list = await (await api("/api/notes/h1/versions")).json();
  assert.equal(list[0].title, "Title"); // newest first
  assert.equal(list[1].title, "first draft");
  const old = await (await api(`/api/notes/h1/versions/${list[1].id}`)).json();
  assert.equal(old.body, "first draft");
  assert.deepEqual(old.tags, []);
  assert.equal((await api(`/api/notes/n1/versions/${list[1].id}`)).status, 404);
  assert.equal((await api(`/api/notes/h1/versions/abc`)).status, 404);
});
