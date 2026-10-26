import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import JSZip from "jszip";
import * as Y from "yjs";
import { createApp } from "../src/app.js";
import { AuthLimiter, clientAddress } from "../src/auth.js";
import type { Config } from "../src/config.js";
import { Store } from "../src/db.js";

// The registration token; note data needs a device token obtained with it.
const REGISTRATION_TOKEN = "test-token-0123456789";
let TOKEN: string;
let dataDir: string;
let app: ReturnType<typeof createApp>;
let base: string;

function testConfig(dir: string, overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    dataDir: dir,
    authToken: REGISTRATION_TOKEN,
    staticDir: null,
    historyIntervalMs: 0,
    trustProxy: false,
    authMaxFailures: 1000,
    authWindowMs: 60_000,
    authLockoutMs: 60_000,
    ...overrides,
  };
}

async function register(host: string, name: string, token = REGISTRATION_TOKEN) {
  return fetch(`http://${host}/api/devices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-editor-"));
  app = createApp(testConfig(dataDir));
  await app.server.listen(0);
  base = `127.0.0.1:${app.server.address.port}`;
  TOKEN = (await (await register(base, "test runner")).json()).token;
});

after(async () => {
  await app.server.destroy();
  app.store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function connect(name: string, token = TOKEN, host = base) {
  const doc = new Y.Doc();
  const websocketProvider = new HocuspocusProviderWebsocket({ url: `ws://${host}` });
  const provider = new HocuspocusProvider({ name, document: doc, token, websocketProvider });
  const synced = new Promise<void>((resolve, reject) => {
    provider.on("synced", () => resolve());
    provider.on("authenticationFailed", ({ reason }: { reason: string }) => reject(new Error(reason)));
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

function api(p: string, token = TOKEN, init: RequestInit = {}, host = base) {
  return fetch(`http://${host}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers },
  });
}

test("rejects a wrong token", async () => {
  const c = connect("note:abc", "wrong-token-xxxxxxxx");
  await assert.rejects(c.synced, /unauthorized/);
  c.close();
  assert.equal((await api("/api/notes", "nope")).status, 401);
});

test("the registration token registers devices but cannot read notes", async () => {
  assert.equal((await api("/api/notes", REGISTRATION_TOKEN)).status, 401);
  const c = connect("note:abc", REGISTRATION_TOKEN);
  await assert.rejects(c.synced, /unauthorized/);
  c.close();
  assert.equal((await register(base, "x", "wrong-token-xxxxxxxx")).status, 401);

  const res = await register(base, "  iPhone  ");
  assert.equal(res.status, 201);
  const device = await res.json();
  assert.equal(device.name, "iPhone");
  assert.match(device.token, /^sed_[A-Za-z0-9_-]{43}$/);
  assert.equal((await api("/api/notes", device.token)).status, 200);
});

test("lists, renames, and revokes devices", async () => {
  const phone = await (await register(base, "phone")).json();
  const c = connect("note:revoke-me", phone.token);
  await c.synced;

  const list = await (await api("/api/devices", phone.token)).json();
  const me = list.find((d: { id: string }) => d.id === phone.id);
  assert.equal(me.current, true);
  assert.equal(list.filter((d: { current: boolean }) => d.current).length, 1);
  assert.equal("token" in me || "tokenHash" in me || "token_hash" in me, false);

  assert.equal((await api("/api/devices/current", phone.token, { method: "PATCH", body: '{"name":"my phone"}' })).status, 200);
  const renamed = (await (await api("/api/devices")).json()).find((d: { id: string }) => d.id === phone.id);
  assert.equal(renamed.name, "my phone");

  // Revoking from another device cuts the phone off, including its open sync connection.
  let closed = false;
  c.provider.on("authenticationFailed", () => (closed = true));
  c.provider.on("close", () => (closed = true));
  assert.equal((await api(`/api/devices/${phone.id}`, TOKEN, { method: "DELETE" })).status, 200);
  await until(() => closed);
  c.close();
  assert.equal((await api("/api/notes", phone.token)).status, 401);
  assert.equal((await api(`/api/devices/${phone.id}`, TOKEN, { method: "DELETE" })).status, 404);
});

test("locks out an address after repeated failures, valid tokens included", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-editor-limit-"));
  const limited = createApp(testConfig(dir, { authMaxFailures: 3 }));
  await limited.server.listen(0);
  const host = `127.0.0.1:${limited.server.address.port}`;
  try {
    const good = (await (await register(host, "ok")).json()).token;
    assert.equal((await api("/api/notes", "bad-1", {}, host)).status, 401);
    assert.equal((await api("/api/notes", "bad-2", {}, host)).status, 401);
    const third = await api("/api/notes", "bad-3", {}, host);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get("retry-after")) > 0);

    assert.equal((await api("/api/notes", good, {}, host)).status, 429);
    assert.equal((await register(host, "x")).status, 429);
    // The sync connection is keyed by the same address, so it is refused too.
    const c = connect("note:abc", good, host);
    await assert.rejects(c.synced, /rate-limited/);
    c.close();
    assert.ok(limited.limiter.retryAfter("127.0.0.1") > 0);
  } finally {
    await limited.server.destroy();
    limited.store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lockouts expire and successes reset the count", () => {
  let now = 0;
  const limiter = new AuthLimiter(3, 1000, 5000, () => now);
  limiter.fail("a");
  limiter.fail("a");
  limiter.succeed("a");
  assert.equal(limiter.fail("a"), false); // count restarted
  now = 2000;
  limiter.fail("a");
  assert.equal(limiter.fail("a"), false); // the first failure fell out of the window
  assert.equal(limiter.fail("a"), true);
  assert.equal(limiter.retryAfter("a"), 5000);
  assert.equal(limiter.retryAfter("b"), 0);
  now = 7000;
  assert.equal(limiter.retryAfter("a"), 0);
});

test("takes the client address from the proxy only when trusted", () => {
  assert.equal(clientAddress("203.0.113.9", "::ffff:10.0.0.2", false), "10.0.0.2");
  assert.equal(clientAddress("1.1.1.1, 192.168.1.20", "172.18.0.3", true), "192.168.1.20");
  assert.equal(clientAddress(null, "172.18.0.3", true), "172.18.0.3");
  assert.equal(clientAddress(undefined, undefined, true), "unknown");
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
