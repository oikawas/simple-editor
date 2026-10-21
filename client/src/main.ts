import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder, drawSelection } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { newId, normalizeTag, summarize, type NoteSummary } from "./notes";
import { loadSettings, saveSettings, type Settings } from "./settings";
import { SyncClient, hasPending, type OpenNote, type Status } from "./sync";
import "./style.css";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const CACHE_KEY = "simple-editor:notes";
const TRASH = "\u0000trash";

let settings: Settings = loadSettings();
let sync: SyncClient | null = null;
let notes = new Map<string, NoteSummary>(loadCache());
let current: { note: OpenNote; view: EditorView; dispose: () => void } | null = null;
let filterTag: string | null = null;

function loadCache(): [string, NoteSummary][] {
  try {
    const list: NoteSummary[] = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]");
    return list.map((n) => [n.id, n]);
  } catch {
    return [];
  }
}

function saveCache(): void {
  localStorage.setItem(CACHE_KEY, JSON.stringify([...notes.values()]));
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${settings.token}` };
}

// ---- note list -------------------------------------------------------------

let refreshTimer: number | undefined;
function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refreshList, 300);
}

async function refreshList(): Promise<void> {
  if (!settings.token) return;
  try {
    const res = await fetch(`${settings.serverUrl}/api/notes`, { headers: authHeaders() });
    if (res.status === 401) return setStatus("unauthorized");
    if (!res.ok) return;
    const server: NoteSummary[] = await res.json();
    const next = new Map(server.map((n) => [n.id, n]));
    // Keep notes the server has not seen yet, and prefer the live copy of the open note.
    for (const [id, n] of notes) if (!next.has(id) && hasPending(id)) next.set(id, n);
    if (current) next.set(current.note.id, summarize(current.note.id, current.note.doc));
    notes = next;
    saveCache();
    renderList();
  } catch {
    // Offline: keep showing the cached list.
  }
}

function visibleNotes(): NoteSummary[] {
  const q = $<HTMLInputElement>("search").value.trim().toLowerCase();
  return [...notes.values()]
    .filter((n) => (filterTag === TRASH ? n.deleted : !n.deleted))
    .filter((n) => !filterTag || filterTag === TRASH || n.tags.includes(filterTag))
    .filter(
      (n) =>
        !q ||
        n.title.toLowerCase().includes(q) ||
        n.preview.toLowerCase().includes(q) ||
        n.tags.some((t) => t.toLowerCase().includes(q)),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderList(): void {
  const list = $("note-list");
  list.replaceChildren(
    ...visibleNotes().map((n) => {
      const li = document.createElement("li");
      li.className = current?.note.id === n.id ? "selected" : "";
      li.onclick = () => void selectNote(n.id);
      const title = document.createElement("div");
      title.className = "title";
      title.textContent = n.title || "（無題）";
      const preview = document.createElement("div");
      preview.className = "preview";
      preview.textContent = n.preview;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = [formatDate(n.updatedAt), ...n.tags.map((t) => `#${t}`)].join("  ");
      li.append(title, preview, meta);
      return li;
    }),
  );
  renderTagFilter();
}

function renderTagFilter(): void {
  const tags = new Set<string>();
  for (const n of notes.values()) if (!n.deleted) n.tags.forEach((t) => tags.add(t));
  const chip = (label: string, value: string | null) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = "chip" + (filterTag === value ? " active" : "");
    b.onclick = () => {
      filterTag = value;
      renderList();
    };
    return b;
  };
  $("tag-filter").replaceChildren(
    chip("すべて", null),
    ...[...tags].sort().map((t) => chip(`#${t}`, t)),
    chip("ゴミ箱", TRASH),
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ---- editor ----------------------------------------------------------------

async function selectNote(id: string, isNew = false): Promise<void> {
  if (!sync) return;
  if (current?.note.id === id) return showEditor();
  closeCurrent();

  const note = await sync.openNote(id);
  sync.active = id;
  const { doc, provider } = note;
  const body = doc.getText("body");
  const meta = doc.getMap("meta");
  const tags = doc.getMap<boolean>("tags");

  if (isNew) {
    doc.transact(() => {
      meta.set("createdAt", Date.now());
      meta.set("updatedAt", Date.now());
    });
  }

  const undoManager = new Y.UndoManager(body);
  const view = new EditorView({
    parent: $("editor"),
    state: EditorState.create({
      doc: body.toString(),
      extensions: [
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
        drawSelection(),
        EditorView.lineWrapping,
        placeholder("最初の行がタイトルになります"),
        yCollab(body, provider.awareness, { undoManager }),
      ],
    }),
  });

  // Record when the user last edited; remote and stored updates are not local.
  let touchTimer: number | undefined;
  const onLocalChange = (tr: Y.Transaction) => {
    if (!tr.local || tr.changed.has(meta as Y.AbstractType<any>)) return;
    clearTimeout(touchTimer);
    touchTimer = window.setTimeout(() => meta.set("updatedAt", Date.now()), 500);
  };
  const onAnyChange = () => {
    notes.set(id, summarize(id, doc));
    saveCache();
    renderList();
    renderMeta();
  };
  doc.on("afterTransaction", onLocalChange);
  doc.on("update", onAnyChange);

  current = {
    note,
    view,
    dispose: () => {
      clearTimeout(touchTimer);
      doc.off("afterTransaction", onLocalChange);
      doc.off("update", onAnyChange);
      undoManager.destroy();
      view.destroy();
    },
  };

  function renderMeta() {
    const s = summarize(id, doc);
    $("dates").textContent = `作成: ${formatDate(s.createdAt)}　更新: ${formatDate(s.updatedAt)}`;
    $("trash-note").textContent = s.deleted ? "↺ 復元" : "🗑";
    $("trash-note").title = s.deleted ? "ゴミ箱から戻す" : "ゴミ箱へ";
    renderTags(tags);
  }

  document.body.classList.add("has-note");
  renderMeta();
  onAnyChange();
  showEditor();
  if (isNew) view.focus();
}

function closeCurrent(): void {
  if (!current) return;
  const { note, dispose } = current;
  dispose();
  note.close();
  current = null;
  if (sync) sync.active = null;
  document.body.classList.remove("has-note");
}

function showEditor(): void {
  document.body.classList.add("show-editor");
}

function renderTags(tags: Y.Map<boolean>): void {
  const box = $("tags");
  const chips = [...tags.keys()].sort().map((t) => {
    const span = document.createElement("span");
    span.className = "chip";
    span.textContent = `#${t}`;
    const x = document.createElement("button");
    x.textContent = "×";
    x.title = "タグを外す";
    x.onclick = () => tags.delete(t);
    span.append(x);
    return span;
  });
  const input = document.createElement("input");
  input.placeholder = "タグを追加";
  input.enterKeyHint = "done";
  const commit = () => {
    const t = normalizeTag(input.value);
    input.value = "";
    if (t) tags.set(t, true);
  };
  input.onkeydown = (e) => {
    if ((e.key === "Enter" || e.key === "," || e.key === " ") && !e.isComposing) {
      e.preventDefault();
      commit();
      ($("tags").querySelector("input") as HTMLInputElement | null)?.focus();
    } else if (e.key === "Backspace" && !input.value && tags.size) {
      tags.delete([...tags.keys()].sort().pop()!);
    }
  };
  input.onblur = commit;
  const hadFocus = document.activeElement?.closest("#tags") != null;
  box.replaceChildren(...chips, input);
  if (hadFocus) input.focus();
}

function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function safeFileName(title: string): string {
  return (title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80) || "untitled") + ".txt";
}

// ---- wiring ----------------------------------------------------------------

function setStatus(s: Status): void {
  const el = $("status");
  el.dataset.state = s;
  el.textContent = { online: "同期中", offline: "オフライン", connecting: "接続中…", unauthorized: "認証エラー" }[s];
}

function connect(): void {
  closeCurrent();
  sync?.destroy();
  sync = null;
  if (!settings.token) {
    setStatus("unauthorized");
    openSettings();
    return;
  }
  sync = new SyncClient(settings, scheduleRefresh, setStatus);
}

function openSettings(): void {
  const dialog = $<HTMLDialogElement>("settings");
  const form = dialog.querySelector("form")!;
  (form.elements.namedItem("serverUrl") as HTMLInputElement).value = settings.serverUrl;
  (form.elements.namedItem("token") as HTMLInputElement).value = settings.token;
  (form.elements.namedItem("deviceName") as HTMLInputElement).value = settings.deviceName;
  dialog.showModal();
}

$("settings").addEventListener("close", () => {
  const dialog = $<HTMLDialogElement>("settings");
  if (dialog.returnValue !== "save") return;
  const form = dialog.querySelector("form")!;
  const next = {
    serverUrl: (form.elements.namedItem("serverUrl") as HTMLInputElement).value.trim() || location.origin,
    token: (form.elements.namedItem("token") as HTMLInputElement).value.trim(),
    deviceName: (form.elements.namedItem("deviceName") as HTMLInputElement).value.trim(),
  };
  saveSettings(next);
  settings = loadSettings();
  connect();
});

$("open-settings").onclick = openSettings;
$("search").oninput = renderList;
$("back").onclick = () => document.body.classList.remove("show-editor");

$("new-note").onclick = () => {
  if (filterTag === TRASH) filterTag = null;
  const id = newId();
  void selectNote(id, true).then(() => {
    if (filterTag && current) current.note.doc.getMap("tags").set(filterTag, true);
  });
};

$("trash-note").onclick = () => {
  if (!current) return;
  const meta = current.note.doc.getMap("meta");
  meta.set("deleted", meta.get("deleted") !== true);
};

$("export-note").onclick = () => {
  if (!current) return;
  const s = summarize(current.note.id, current.note.doc);
  const body = current.note.doc.getText("body").toString();
  downloadBlob(new Blob([body], { type: "text/plain;charset=utf-8" }), safeFileName(s.title));
};

$("export-all").onclick = async () => {
  try {
    const res = await fetch(`${settings.serverUrl}/api/export.zip`, { headers: authHeaders() });
    if (!res.ok) throw new Error(String(res.status));
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(await res.blob(), `notes-${stamp}.zip`);
  } catch (e) {
    alert(`書き出しに失敗しました (${e})。サーバーに接続できるか確認してください。`);
  }
};

renderList();
connect();
