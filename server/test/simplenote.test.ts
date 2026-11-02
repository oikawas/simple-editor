import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import JSZip from "jszip";
import * as Y from "yjs";
import { createApp } from "../src/app.js";
import {
  buildNoteDoc,
  creationTime,
  lastLineDate,
  noteIdFor,
  readSimplenoteExport,
  startOfDay,
  validTimeZone,
} from "../src/simplenote.js";

const REGISTRATION_TOKEN = "test-token-0123456789";
const TZ = "Asia/Tokyo";
let dataDir: string;
let app: ReturnType<typeof createApp>;
let base: string;
let token: string;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "simple-editor-import-"));
  app = createApp({
    port: 0,
    dataDir,
    authToken: REGISTRATION_TOKEN,
    staticDir: null,
    historyIntervalMs: 0,
    trustProxy: false,
    authMaxFailures: 1000,
    authWindowMs: 60_000,
    authLockoutMs: 60_000,
  });
  await app.server.listen(0);
  base = `http://127.0.0.1:${app.server.address.port}`;
  const res = await fetch(`${base}/api/devices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REGISTRATION_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "import test" }),
  });
  token = (await res.json()).token;
});

after(async () => {
  await app.server.destroy();
  app.store.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const exportJson = {
  activeNotes: [
    {
      id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      content: "買い物\r\n牛乳\r\n\r\n2020/03/04\r\n",
      creationDate: "2023-01-01T00:00:00.000Z",
      lastModified: "2023-02-01T00:00:00.000Z",
      tags: ["家", "to do"],
    },
    {
      id: "agtzaW1wbGUtbm90ZXIRCxIETm90ZRiAgID4_old_style_id",
      content: "日付のないノート",
      creationDate: "2021-05-06T07:08:09.000Z",
      lastModified: "2021-05-07T00:00:00.000Z",
      tags: [],
    },
  ],
  trashedNotes: [{ id: "trashed", content: "消したノート", creationDate: "2020-01-01T00:00:00.000Z", tags: [] }],
};

async function exportZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("source/notes.json", JSON.stringify(exportJson));
  zip.file("買い物.txt", "買い物\n牛乳\n");
  return zip.generateAsync({ type: "nodebuffer" });
}

function importFile(body: Buffer | string) {
  return fetch(`${base}/api/import/simplenote?tz=${encodeURIComponent(TZ)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
    body,
  });
}

test("finds a date alone on the last non-empty line", () => {
  assert.deepEqual(lastLineDate("本文\n2024/01/02"), { year: 2024, month: 1, day: 2 });
  assert.deepEqual(lastLineDate("本文\n 2024/1/2 \n\n"), { year: 2024, month: 1, day: 2 });
  assert.equal(lastLineDate("2024/01/02\n本文"), null);
  assert.equal(lastLineDate("本文\n2024/01/02 の続き"), null);
  assert.equal(lastLineDate("本文\n2024-01-02"), null);
  assert.equal(lastLineDate("本文\n2023/02/29"), null);
  assert.equal(lastLineDate(""), null);
});

test("dates start at midnight in the importing device's time zone", () => {
  assert.equal(startOfDay({ year: 2024, month: 1, day: 2 }, TZ), Date.parse("2024-01-02T00:00:00+09:00"));
  assert.equal(startOfDay({ year: 2024, month: 7, day: 1 }, "America/New_York"), Date.parse("2024-07-01T00:00:00-04:00"));
  assert.equal(startOfDay({ year: 2024, month: 1, day: 2 }, "UTC"), Date.parse("2024-01-02T00:00:00Z"));
  assert.equal(validTimeZone("Not/A_Zone"), "UTC");
  assert.equal(validTimeZone(null), "UTC");
});

test("the creation date comes from the last line, else from Simplenote", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  // The last-line date wins over Simplenote's creation date.
  assert.equal(
    creationTime({ id: "a", content: "x\n2020/03/04", creationDate: "2023-01-01T00:00:00Z" }, TZ, now),
    Date.parse("2020-03-04T00:00:00+09:00"),
  );
  // Simplenote's time of day is kept when it was created that same day.
  assert.equal(
    creationTime({ id: "a", content: "x\n2020/03/04", creationDate: "2020-03-04T12:34:56+09:00" }, TZ, now),
    Date.parse("2020-03-04T12:34:56+09:00"),
  );
  assert.equal(
    creationTime({ id: "a", content: "x", creationDate: "2021-05-06T07:08:09Z" }, TZ, now),
    Date.parse("2021-05-06T07:08:09Z"),
  );
  assert.equal(creationTime({ id: "a", content: "x", creationDate: 1600000000 }, TZ, now), 1600000000 * 1000);
  assert.equal(creationTime({ id: "a", content: "x" }, TZ, now), now);
});

test("note ids follow from Simplenote ids", () => {
  assert.equal(noteIdFor("0a1b2c3d"), "sn-0a1b2c3d");
  const odd = noteIdFor("agtz_with/odd+chars");
  assert.match(odd, /^sn-[0-9a-f]{32}$/);
  assert.equal(noteIdFor("agtz_with/odd+chars"), odd);
});

test("builds a note document with body, dates, and tags", () => {
  const doc = buildNoteDoc(exportJson.activeNotes[0], TZ, Date.now());
  assert.equal(doc.getText("body").toString(), "買い物\n牛乳\n\n2020/03/04\n");
  assert.equal(doc.getMap("meta").get("createdAt"), Date.parse("2020-03-04T00:00:00+09:00"));
  assert.equal(doc.getMap("meta").get("updatedAt"), Date.parse("2023-02-01T00:00:00Z"));
  assert.deepEqual([...doc.getMap("tags").keys()].sort(), ["to-do", "家"]);
});

test("reads notes.json from the zip or on its own, and rejects other files", async () => {
  assert.equal((await readSimplenoteExport(await exportZip())).length, 2);
  assert.equal((await readSimplenoteExport(Buffer.from("﻿" + JSON.stringify(exportJson)))).length, 2);
  await assert.rejects(readSimplenoteExport(Buffer.from("hello")));
  const other = new JSZip();
  other.file("readme.txt", "hi");
  await assert.rejects(readSimplenoteExport(await other.generateAsync({ type: "nodebuffer" })));
});

test("imports active notes over HTTP, once", async () => {
  const unauthorized = await fetch(`${base}/api/import/simplenote`, { method: "POST", body: "{}" });
  assert.equal(unauthorized.status, 401);
  assert.equal((await importFile("not an export")).status, 400);

  const first = await importFile(await exportZip());
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { total: 2, imported: 2, skipped: 0 });

  const notes = await (await fetch(`${base}/api/notes`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(notes.length, 2);
  const shopping = notes.find((n: any) => n.id === "sn-0a1b2c3d4e5f60718293a4b5c6d7e8f9");
  assert.equal(shopping.title, "買い物");
  assert.deepEqual(shopping.tags, ["to-do", "家"]);
  assert.equal(shopping.createdAt, Date.parse("2020-03-04T00:00:00+09:00"));
  assert.equal(shopping.deleted, false);
  const dateless = notes.find((n: any) => n.title === "日付のないノート");
  assert.equal(dateless.createdAt, Date.parse("2021-05-06T07:08:09Z"));

  // Searchable, with a first version, and readable as a synced document.
  const hits = await (await fetch(`${base}/api/search?q=牛乳`, { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.deepEqual(hits.map((h: any) => h.id), [shopping.id]);
  assert.equal(app.store.listVersions(shopping.id).length, 1);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, app.store.loadState(`note:${shopping.id}`)!);
  assert.equal(doc.getText("body").toString(), "買い物\n牛乳\n\n2020/03/04\n");

  // Importing again adds nothing.
  const second = await importFile(JSON.stringify(exportJson));
  assert.deepEqual(await second.json(), { total: 2, imported: 0, skipped: 2 });
});
