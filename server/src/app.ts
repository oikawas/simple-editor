import { Server, type Document } from "@hocuspocus/server";
import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import * as Y from "yjs";
import type { Config } from "./config.js";
import { Store } from "./db.js";
import { buildZip, fileNameFor } from "./export.js";
import { INDEX_DOC, NOTE_PREFIX, bodyOf, noteIdFromDocName, summarize } from "./note.js";

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

export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

export function createApp(config: Config) {
  const store = new Store(config.dataDir);
  buildSearchIndex(store);

  const server = new Server({
    port: config.port,
    quiet: true,
    stopOnSignals: false,
    debounce: 1000,
    maxDebounce: 5000,

    async onAuthenticate({ token, documentName }) {
      if (!tokenMatches(config.authToken, token)) throw new Error("unauthorized");
      if (documentName !== INDEX_DOC && !noteIdFromDocName(documentName)) throw new Error("bad document name");
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
      if (!tokenMatches(config.authToken, token)) return send(res, 401, { error: "unauthorized" });
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });

      if (p === "/api/notes") return send(res, 200, store.listNotes());

      if (p === "/api/search") return send(res, 200, store.search(url.searchParams.get("q") ?? ""));

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
          .filter((n) => includeTrash || !n.deleted)
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

  return { server, store };
}

// Databases created before full-text search existed have no index yet.
function buildSearchIndex(store: Store): void {
  if (!store.isSearchIndexEmpty()) return;
  for (const name of store.listDocumentNames()) {
    const id = noteIdFromDocName(name);
    const state = store.loadState(name);
    if (!id || !state) continue;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    store.indexBody(id, bodyOf(doc), summarize(doc).tags);
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
