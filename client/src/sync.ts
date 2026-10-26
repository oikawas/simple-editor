import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import { docName } from "./notes";
import { syncUrl, type Settings } from "./settings";

export type Status = "online" | "offline" | "connecting" | "unauthorized" | "rate-limited";

export interface OpenNote {
  id: string;
  doc: Y.Doc;
  provider: HocuspocusProvider;
  close(): void;
}

const PENDING_KEY = "simple-editor:pending";

// Notes with local edits the server has not acknowledged yet. Each note is
// also kept in IndexedDB, so edits survive restarts and are pushed on reconnect.
function pending(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function setPending(id: string, on: boolean): void {
  const p = pending();
  if (on === p.has(id)) return;
  if (on) p.add(id);
  else p.delete(id);
  localStorage.setItem(PENDING_KEY, JSON.stringify([...p]));
}

export function hasPending(id: string): boolean {
  return pending().has(id);
}

export class SyncClient {
  private ws: HocuspocusProviderWebsocket;
  private index: HocuspocusProvider;
  private open = new Map<string, OpenNote>();
  // The note shown in the editor; background flushing leaves it open.
  active: string | null = null;

  // Set once the server refuses the token; reconnecting would only add failures.
  private stopped = false;

  constructor(
    private settings: Settings,
    private onIndexChanged: () => void,
    private onStatus: (s: Status) => void,
    private onAuthFailed: (reason: string) => void,
  ) {
    this.ws = new HocuspocusProviderWebsocket({ url: syncUrl(settings) });
    this.ws.on("status", ({ status }: { status: string }) => {
      if (this.stopped) return;
      this.onStatus(status === "connected" ? "online" : status === "connecting" ? "connecting" : "offline");
      if (status === "connected") {
        this.onIndexChanged();
        void this.flushPending();
      }
    });
    // An empty document every client subscribes to; the server broadcasts
    // a message on it whenever any note is stored.
    this.index = new HocuspocusProvider({
      name: "__index",
      token: settings.deviceToken,
      websocketProvider: this.ws,
      onStateless: () => this.onIndexChanged(),
      onAuthenticationFailed: ({ reason }: { reason: string }) => this.authFailed(reason),
    });
    this.index.attach();

    // Phones often keep a dead socket around; follow the OS network state instead.
    window.addEventListener("offline", this.goOffline);
    window.addEventListener("online", this.goOnline);
  }

  private goOffline = () => this.ws.disconnect();
  private goOnline = () => {
    if (!this.stopped) void this.ws.connect();
  };

  private authFailed(reason: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.ws.disconnect();
    this.onAuthFailed(reason);
  }

  async openNote(id: string): Promise<OpenNote> {
    const existing = this.open.get(id);
    if (existing) return existing;

    const doc = new Y.Doc();
    const local = new IndexeddbPersistence(docName(id), doc);
    await local.whenSynced;

    const provider = new HocuspocusProvider({
      name: docName(id),
      document: doc,
      token: this.settings.deviceToken,
      websocketProvider: this.ws,
      onAuthenticationFailed: ({ reason }: { reason: string }) => this.authFailed(reason),
    });
    doc.on("afterTransaction", (tr: Y.Transaction) => {
      if (tr.local && tr.changed.size > 0) setPending(id, true);
    });
    provider.on("unsyncedChanges", ({ number }: { number: number }) => {
      if (number === 0) setPending(id, false);
    });
    provider.awareness?.setLocalStateField("user", { name: this.settings.deviceName, color: "#2f6fde" });
    provider.attach();

    const note: OpenNote = {
      id,
      doc,
      provider,
      close: () => {
        this.open.delete(id);
        provider.destroy();
        void local.destroy();
        doc.destroy();
      },
    };
    this.open.set(id, note);
    return note;
  }

  // Push notes edited offline that are not open in the editor.
  private flushing = false;
  async flushPending(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const id of pending()) {
        if (this.open.has(id)) continue;
        const note = await this.openNote(id);
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, 15000);
          note.provider.on("unsyncedChanges", ({ number }: { number: number }) => number === 0 && done());
        });
        if (this.open.get(id) === note && this.active !== id) note.close();
      }
    } finally {
      this.flushing = false;
    }
  }

  isOpen(id: string): boolean {
    return this.open.has(id);
  }

  destroy(): void {
    window.removeEventListener("offline", this.goOffline);
    window.removeEventListener("online", this.goOnline);
    for (const n of [...this.open.values()]) n.close();
    this.index.destroy();
    this.ws.destroy();
  }
}
