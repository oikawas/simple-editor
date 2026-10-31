import { Server, type Document } from "@hocuspocus/server";
import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import * as Y from "yjs";
import { AuthLimiter, clientAddress, hashToken, newDeviceToken, tokenMatches } from "./auth.js";
import type { Config } from "./config.js";
import { Store, type Device } from "./db.js";
import { buildZip, fileNameFor } from "./export.js";
import { INDEX_DOC, NOTE_PREFIX, bodyOf, diaryDate, noteIdFromDocName, restoreMarkOf, summarize } from "./note.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

// Set on WebSocket upgrades so the address survives into the auth hook, which
// only sees request headers. Any value the client sends is overwritten.
const REMOTE_ADDR_HEADER = "x-simple-editor-remote-addr";

type AuthFailure = { ok: false; status: 401 | 429; retryAfterMs: number };
type AuthResult = { ok: true; device: Device } | AuthFailure;

class AuthError extends Error {
  constructor(public reason: "unauthorized" | "rate-limited") {
    super(reason);
  }
}

export function createApp(config: Config) {
  const store = new Store(config.dataDir);
  buildDerivedData(store);
  const limiter = new AuthLimiter(config.authMaxFailures, config.authWindowMs, config.authLockoutMs);

  function locked(address: string): AuthFailure | null {
    const retryAfterMs = limiter.retryAfter(address);
    return retryAfterMs > 0 ? { ok: false, status: 429, retryAfterMs } : null;
  }

  function failed(address: string): AuthFailure {
    if (limiter.fail(address)) {
      console.warn(`auth: too many failures from ${address}; locked out`);
      return { ok: false, status: 429, retryAfterMs: limiter.retryAfter(address) };
    }
    console.warn(`auth: rejected credentials from ${address}`);
    return { ok: false, status: 401, retryAfterMs: 0 };
  }

  // Note data is only reachable with a device token. AUTH_TOKEN registers devices.
  function authenticateDevice(token: string | null, address: string): AuthResult {
    const lockout = locked(address);
    if (lockout) return lockout;
    const device = token ? store.findDeviceByTokenHash(hashToken(token)) : null;
    if (!device) return failed(address);
    limiter.succeed(address);
    const now = Date.now();
    if (now - device.lastSeenAt > 60_000) store.touchDevice(device.id, now);
    return { ok: true, device };
  }

  function authenticateRegistration(token: string | null, address: string): AuthFailure | null {
    const lockout = locked(address);
    if (lockout) return lockout;
    if (!tokenMatches(config.authToken, token)) return failed(address);
    limiter.succeed(address);
    return null;
  }

  // Closes the WebSockets a device has open, e.g. once it is revoked. Closing
  // the socket (not just its documents) makes clients reconnect, and the
  // refused token then tells them they were revoked.
  function disconnectDevice(deviceId: string): void {
    for (const doc of server.hocuspocus.documents.values()) {
      for (const connection of doc.getConnections()) {
        if (connection.context?.deviceId === deviceId) connection.webSocket.close(4401, "unauthorized");
      }
    }
  }

  const server = new Server({
    port: config.port,
    quiet: true,
    stopOnSignals: false,
    debounce: 1000,
    maxDebounce: 5000,

    async onUpgrade({ request }) {
      request.headers[REMOTE_ADDR_HEADER] = request.socket.remoteAddress ?? "";
    },

    async onAuthenticate({ token, documentName, requestHeaders }) {
      const address = clientAddress(
        requestHeaders.get("x-forwarded-for"),
        requestHeaders.get(REMOTE_ADDR_HEADER),
        config.trustProxy,
      );
      const result = authenticateDevice(token, address);
      if (!result.ok) throw new AuthError(result.status === 429 ? "rate-limited" : "unauthorized");
      if (documentName !== INDEX_DOC && !noteIdFromDocName(documentName)) throw new Error("bad document name");
      return { deviceId: result.device.id };
    },

    async onLoadDocument({ document, documentName }) {
      const state = store.loadState(documentName);
      if (state) Y.applyUpdate(document, state);
    },

    async onStoreDocument({ document, documentName }) {
      const id = noteIdFromDocName(documentName);
      if (!id) return;
      store.saveState(documentName, Y.encodeStateAsUpdate(document));
      const now = Date.now();
      const s = summarize(document);
      const previous = store.getNote(id);
      store.upsertNote({
        id,
        ...s,
        createdAt: previous?.createdAt ?? s.createdAt ?? now,
        updatedAt: s.updatedAt ?? now,
      });
      store.indexBody(id, bodyOf(document), s.tags);
      store.recordVersion(id, bodyOf(document), s.tags, now, config.historyIntervalMs, restoreMarkOf(document));
      // Tell every client watching the index that the list changed.
      server.hocuspocus.documents.get(INDEX_DOC)?.broadcastStateless(JSON.stringify({ type: "changed", id }));
    },

    async onRequest({ request, response }) {
      const handled = await handleHttp(request, response);
      // Rejecting with no error tells Hocuspocus the response was already sent.
      if (handled) throw null;
    },
  });

  function currentDoc(id: string): Y.Doc | null {
    const name = NOTE_PREFIX + id;
    const live: Document | undefined = server.hocuspocus.documents.get(name);
    if (live) return live;
    const state = store.loadState(name);
    if (!state) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    if (p === "/api/health") return send(res, 200, { ok: true });

    if (p.startsWith("/api/")) {
      const auth = req.headers.authorization;
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      const address = clientAddress(
        req.headers["x-forwarded-for"] as string | undefined,
        req.socket.remoteAddress,
        config.trustProxy,
      );

      if (p === "/api/devices" && req.method === "POST") {
        const denied = authenticateRegistration(token, address);
        if (denied) return refuse(res, denied);
        const body = await readJson(req);
        const name = deviceName(body?.name);
        const deviceToken = newDeviceToken();
        const device = store.createDevice(crypto.randomUUID(), name, hashToken(deviceToken), Date.now());
        console.log(`auth: registered device "${name}" (${device.id}) from ${address}`);
        return send(res, 201, { ...device, token: deviceToken });
      }

      const result = authenticateDevice(token, address);
      if (!result.ok) return refuse(res, result);
      const self = result.device;

      if (p === "/api/devices" && req.method === "GET") {
        return send(
          res,
          200,
          store.listDevices().map((d) => ({ ...d, current: d.id === self.id })),
        );
      }

      if (p === "/api/devices/current" && req.method === "PATCH") {
        const body = await readJson(req);
        store.renameDevice(self.id, deviceName(body?.name));
        return send(res, 200, { ok: true });
      }

      const revoke = p.match(/^\/api\/devices\/([0-9a-f-]{36})$/);
      if (revoke && req.method === "DELETE") {
        if (!store.deleteDevice(revoke[1])) return send(res, 404, { error: "not found" });
        disconnectDevice(revoke[1]);
        console.log(`auth: device ${revoke[1]} revoked by ${self.id}`);
        return send(res, 200, { ok: true });
      }

      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });

      if (p === "/api/notes") return send(res, 200, store.listNotes());

      if (p === "/api/search") return send(res, 200, store.search(url.searchParams.get("q") ?? ""));

      const versions = p.match(/^\/api\/notes\/([A-Za-z0-9-]{1,64})\/versions$/);
      if (versions) return send(res, 200, store.listVersions(versions[1]));

      const version = p.match(/^\/api\/notes\/([A-Za-z0-9-]{1,64})\/versions\/(\d{1,15})$/);
      if (version) {
        const v = store.getVersion(version[1], Number(version[2]));
        return v ? send(res, 200, v) : send(res, 404, { error: "not found" });
      }

      const m = p.match(/^\/api\/notes\/([A-Za-z0-9-]{1,64})\.txt$/);
      if (m) {
        const note = store.getNote(m[1]);
        const doc = currentDoc(m[1]);
        if (!note || !doc) return send(res, 404, { error: "not found" });
        const name = fileNameFor(note, new Set());
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        });
        res.end(bodyOf(doc));
        return true;
      }

      if (p === "/api/export.zip") {
        const includeTrash = url.searchParams.get("trash") === "1";
        const entries = store
          .listNotes()
          .filter((n) => includeTrash || !n.deleted || diaryDate(n.id))
          .flatMap((note) => {
            const doc = currentDoc(note.id);
            return doc ? [{ note, body: bodyOf(doc) }] : [];
          });
        const zip = await buildZip(entries);
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="notes-${stamp}.zip"`,
        });
        res.end(zip);
        return true;
      }

      return send(res, 404, { error: "not found" });
    }

    if (config.staticDir) return serveStatic(config.staticDir, p, res);
    return false;
  }

  return { server, store, limiter };
}

function deviceName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().slice(0, 64) : "";
  return name || "端末";
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) return null;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

function refuse(res: ServerResponse, result: AuthFailure): true {
  if (result.status === 429) {
    res.setHeader("Retry-After", String(Math.ceil(result.retryAfterMs / 1000)));
    return send(res, 429, { error: "rate-limited", retryAfter: Math.ceil(result.retryAfterMs / 1000) });
  }
  return send(res, 401, { error: "unauthorized" });
}

// Databases created before full-text search or history existed lack the
// search index and a first version; derive them from the stored documents.
function buildDerivedData(store: Store): void {
  const indexEmpty = store.isSearchIndexEmpty();
  for (const name of store.listDocumentNames()) {
    const id = noteIdFromDocName(name);
    if (!id) continue;
    const needsVersion = !store.hasVersions(id);
    if (!indexEmpty && !needsVersion) continue;
    const state = store.loadState(name);
    if (!state) continue;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const { tags } = summarize(doc);
    if (indexEmpty) store.indexBody(id, bodyOf(doc), tags);
    if (needsVersion) {
      const savedAt = store.getNote(id)?.updatedAt ?? Date.now();
      store.recordVersion(id, bodyOf(doc), tags, savedAt, 0, restoreMarkOf(doc));
    }
    doc.destroy();
  }
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
  return true;
}

function serveStatic(root: string, pathname: string, res: ServerResponse): true {
  let file = path.normalize(path.join(root, decodeURIComponent(pathname)));
  if (!file.startsWith(root + path.sep) && file !== root) return send(res, 403, { error: "forbidden" });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
  const ext = path.extname(file);
  // Hashed assets can be cached forever; the shell and service worker must revalidate.
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}
