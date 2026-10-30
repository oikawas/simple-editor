import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder, drawSelection } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { ApiError, listDevices, registerDevice, renameThisDevice, revokeDevice } from "./api";
import { lineDiff, restoreVersion, type Version, type VersionInfo } from "./history";
import { newId, normalizeTag, summarize, type NoteSummary } from "./notes";
import { applyDisplay, loadDisplay, loadSettings, saveDisplay, saveSettings, type Settings } from "./settings";
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
  return { Authorization: `Bearer ${settings.deviceToken}` };
}

// Fetches from the API with this device's token. A refused token or a
// lockout is reported once and stops further attempts.
async function apiFetch(path: string): Promise<Response> {
  const res = await fetch(`${settings.serverUrl}${path}`, { headers: authHeaders() });
  if (res.status === 401) authFailed("unauthorized");
  if (res.status === 429) authFailed("rate-limited", Number(res.headers.get("retry-after") ?? 60));
  return res;
}

// ---- note list -------------------------------------------------------------

let refreshTimer: number | undefined;
function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(refreshList, 300);
}

async function refreshList(): Promise<void> {
  if (!settings.deviceToken) return;
  try {
    const res = await apiFetch("/api/notes");
    if (!res.ok) return;
    const server: NoteSummary[] = await res.json();
    const next = new Map(server.map((n) => [n.id, n]));
    // Keep notes the server has not seen yet, and prefer the live copy of the open note.
    for (const [id, n] of notes) if (!next.has(id) && hasPending(id)) next.set(id, n);
    if (current) next.set(current.note.id, summarize(current.note.id, current.note.doc));
    notes = next;
    saveCache();
    if (searchQuery()) void runSearch();
    else renderList();
  } catch {
    // Offline: keep showing the cached list.
  }
}

// ---- search ----------------------------------------------------------------

// Full-text hits from the server for `query` (note id -> excerpt). Null when the
// server could not be reached; the list then falls back to local matching.
let searchResults: { query: string; hits: Map<string, string> } | null = null;
let searchTimer: number | undefined;

function searchQuery(): string {
  return $<HTMLInputElement>("search").value.trim();
}

function searchTerms(): string[] {
  return searchQuery().toLowerCase().split(/\s+/).filter(Boolean);
}

function scheduleSearch(): void {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 200);
}

async function runSearch(): Promise<void> {
  const query = searchQuery();
  if (!query || !settings.deviceToken) {
    searchResults = null;
    return renderList();
  }
  try {
    const res = await apiFetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(String(res.status));
    const hits: { id: string; snippet: string }[] = await res.json();
    if (query !== searchQuery()) return; // a newer search is on its way
    searchResults = { query, hits: new Map(hits.map((h) => [h.id, h.snippet])) };
  } catch {
    searchResults = null;
  }
  renderList();
}

// Matches what this device already has: the list summaries, plus the full
// text of the open note (which may be ahead of the server).
function matchesLocally(n: NoteSummary, terms: string[]): boolean {
  const body = current?.note.id === n.id ? current.note.doc.getText("body").toString() : "";
  const haystack = [n.title, n.preview, body, ...n.tags].join("\n").toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

function serverHits(): Map<string, string> | null {
  return searchResults && searchResults.query === searchQuery() ? searchResults.hits : null;
}

function visibleNotes(): NoteSummary[] {
  const terms = searchTerms();
  const hits = serverHits();
  return [...notes.values()]
    .filter((n) => (filterTag === TRASH ? n.deleted : !n.deleted))
    .filter((n) => !filterTag || filterTag === TRASH || n.tags.includes(filterTag))
    .filter((n) => terms.length === 0 || hits?.has(n.id) || matchesLocally(n, terms))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Text with every search term wrapped in <mark>, built without innerHTML.
function highlighted(text: string, terms: string[]): Node[] {
  if (terms.length === 0) return [document.createTextNode(text)];
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(pattern).map((part, i) => {
    if (i % 2 === 0) return document.createTextNode(part);
    const mark = document.createElement("mark");
    mark.textContent = part;
    return mark;
  });
}

function renderList(): void {
  const list = $("note-list");
  const terms = searchTerms();
  const hits = serverHits();
  const items = visibleNotes().map((n) => {
    const li = document.createElement("li");
    li.className = current?.note.id === n.id ? "selected" : "";
    li.onclick = () => void selectNote(n.id);
    const title = document.createElement("div");
    title.className = "title";
    title.append(...highlighted(n.title || "（無題）", terms));
    const preview = document.createElement("div");
    preview.className = "preview";
    preview.append(...highlighted((terms.length && hits?.get(n.id)) || n.preview, terms));
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = [formatDate(n.updatedAt), ...n.tags.map((t) => `#${t}`)].join("  ");
    li.append(title, preview, meta);
    return li;
  });
  if (terms.length && !hits && $("status").dataset.state !== "online") {
    const note = document.createElement("li");
    note.className = "notice";
    note.textContent = "オフラインのため、本文はこの端末で開いているノートだけを検索しています";
    items.push(note);
  }
  list.replaceChildren(...items);
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

function formatDate(ms: number, withSeconds = false): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: withSeconds ? "medium" : "short" });
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
  el.textContent = {
    online: "同期中",
    offline: "オフライン",
    connecting: "接続中…",
    unauthorized: "未登録",
    "rate-limited": "一時停止中",
  }[s];
}

let retryTimer: number | undefined;

function connect(): void {
  clearTimeout(retryTimer);
  closeCurrent();
  sync?.destroy();
  sync = null;
  if (!settings.deviceToken) {
    if (settings.legacyToken) return void migrate();
    setStatus("unauthorized");
    openSettings();
    return;
  }
  sync = new SyncClient(settings, scheduleRefresh, setStatus, (reason) =>
    authFailed(reason === "rate-limited" ? "rate-limited" : "unauthorized"),
  );
}

// The server refused this device's token (revoked or unknown), or locked
// this address out after repeated failures.
function authFailed(kind: "unauthorized" | "rate-limited", retryAfterSeconds = 60): void {
  if (!sync && kind === "rate-limited" && retryTimer) return;
  closeCurrent();
  sync?.destroy();
  sync = null;
  if (kind === "rate-limited") {
    setStatus("rate-limited");
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connect, Math.max(retryAfterSeconds, 5) * 1000);
    return;
  }
  if (!settings.deviceToken) return;
  settings = { ...settings, deviceToken: "", deviceId: "" };
  saveSettings(settings);
  setStatus("unauthorized");
  openSettings("この端末の登録が解除されたか、無効になっています。登録用トークンで登録し直してください。");
}

// Devices set up before per-device tokens stored the registration token;
// exchange it for a device token of their own.
async function migrate(): Promise<void> {
  try {
    const device = await registerDevice(settings.serverUrl, settings.legacyToken, settings.deviceName);
    settings = { ...settings, deviceToken: device.token, deviceId: device.id, legacyToken: "" };
    saveSettings(settings);
    connect();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      settings = { ...settings, legacyToken: "" };
      saveSettings(settings);
      setStatus("unauthorized");
      openSettings("保存されていたトークンでは登録できませんでした。登録用トークンを入力してください。");
    } else if (e instanceof ApiError && e.status === 429) {
      setStatus("rate-limited");
      retryTimer = window.setTimeout(connect, Math.max(e.retryAfter, 5) * 1000);
    } else {
      // Offline: keep the stored token and try again later.
      setStatus("offline");
      retryTimer = window.setTimeout(connect, 30_000);
    }
  }
}

// ---- settings and devices --------------------------------------------------

const settingsForm = () => $("settings").querySelector("form")!;
const field = (name: string) => settingsForm().elements.namedItem(name) as HTMLInputElement;

function needsRegistration(): boolean {
  const url = field("serverUrl").value.trim().replace(/\/+$/, "") || location.origin;
  return !settings.deviceToken || url !== settings.serverUrl;
}

function showSettingsMessage(text: string): void {
  const el = $("settings-message");
  el.textContent = text;
  el.hidden = !text;
}

function openSettings(message = ""): void {
  const dialog = $<HTMLDialogElement>("settings");
  field("serverUrl").value = settings.serverUrl;
  field("deviceName").value = settings.deviceName;
  field("registrationToken").value = "";
  const display = loadDisplay();
  field("fontSize").value = String(display.fontSize);
  field("lineHeight").value = display.lineHeight.toFixed(1);
  showSettingsMessage(message);
  updateSettingsForm();
  if (!dialog.open) dialog.showModal();
  if (settings.deviceToken) void renderDevices();
}

function updateSettingsForm(): void {
  const register = needsRegistration();
  $("register-fields").hidden = !register;
  field("registrationToken").required = register;
  $("devices-section").hidden = register;
  $("export-all").hidden = !settings.deviceToken;
  $("settings-save").textContent = register ? "登録" : "保存";
}

function describeError(e: unknown): string {
  if (e instanceof ApiError && e.status === 401) return "登録用トークンが違います。";
  if (e instanceof ApiError && e.status === 429) {
    return `失敗が続いたため、一時的に受け付けを停止しています。${Math.ceil(e.retryAfter / 60)} 分ほど待ってから試してください。`;
  }
  if (e instanceof ApiError) return `サーバーでエラーが発生しました (${e.status})。`;
  return "サーバーに接続できません。URL とネットワークを確認してください。";
}

async function renderDevices(): Promise<void> {
  const list = $("device-list");
  list.replaceChildren(notice("読み込み中…"));
  try {
    const devices = await listDevices(settings.serverUrl, settings.deviceToken);
    list.replaceChildren(
      ...devices.map((d) => {
        const li = document.createElement("div");
        const info = document.createElement("div");
        const name = document.createElement("div");
        name.className = "title";
        name.textContent = d.current ? `${d.name}（この端末）` : d.name;
        const dates = document.createElement("div");
        dates.className = "preview";
        dates.textContent = `最終接続 ${formatDate(d.lastSeenAt)} · 登録 ${formatDate(d.createdAt)}`;
        info.append(name, dates);
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.textContent = "登録解除";
        revoke.onclick = () => void revokeFromSettings(d.id, d.name, d.current);
        li.append(info, revoke);
        return li;
      }),
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return authFailed("unauthorized");
    list.replaceChildren(notice(describeError(e)));
  }
}

async function revokeFromSettings(id: string, name: string, current: boolean): Promise<void> {
  const question = current
    ? "この端末の登録を解除しますか？ もう一度使うには登録用トークンが必要です。"
    : `「${name}」の登録を解除しますか？ その端末はすぐに同期できなくなります。`;
  if (!confirm(question)) return;
  try {
    await revokeDevice(settings.serverUrl, settings.deviceToken, id);
  } catch (e) {
    showSettingsMessage(describeError(e));
    return;
  }
  if (current) {
    authFailed("unauthorized");
    openSettings("この端末の登録を解除しました。");
  } else {
    void renderDevices();
  }
}

// Display changes apply at once and are kept even if the dialog is closed.
settingsForm().addEventListener("change", (e) => {
  const name = (e.target as HTMLElement).getAttribute("name");
  if (name !== "fontSize" && name !== "lineHeight") return;
  const display = { fontSize: Number(field("fontSize").value), lineHeight: Number(field("lineHeight").value) };
  saveDisplay(display);
  applyDisplay(display);
});

settingsForm().addEventListener("input", (e) => {
  if ((e.target as HTMLElement).getAttribute("name") === "serverUrl") updateSettingsForm();
});

settingsForm().addEventListener("submit", async (e) => {
  e.preventDefault();
  const serverUrl = field("serverUrl").value.trim().replace(/\/+$/, "") || location.origin;
  const deviceName = field("deviceName").value.trim() || settings.deviceName;
  const save = $<HTMLButtonElement>("settings-save");
  save.disabled = true;
  try {
    if (needsRegistration()) {
      const device = await registerDevice(serverUrl, field("registrationToken").value.trim(), deviceName);
      settings = { serverUrl, deviceName, deviceToken: device.token, deviceId: device.id, legacyToken: "" };
      saveSettings(settings);
      connect();
    } else if (deviceName !== settings.deviceName) {
      await renameThisDevice(settings.serverUrl, settings.deviceToken, deviceName);
      settings = { ...settings, deviceName };
      saveSettings(settings);
    }
    $<HTMLDialogElement>("settings").close();
  } catch (err) {
    showSettingsMessage(describeError(err));
  } finally {
    save.disabled = false;
  }
});

$("settings-cancel").onclick = () => $<HTMLDialogElement>("settings").close();

$("open-settings").onclick = () => openSettings();
$("search").oninput = () => {
  renderList();
  scheduleSearch();
};
$("back").onclick = () => document.body.classList.remove("show-editor");

$("new-note").onclick = () => {
  if (filterTag === TRASH) filterTag = null;
  const id = newId();
  void selectNote(id, true).then(() => {
    if (filterTag && current) current.note.doc.getMap("tags").set(filterTag, true);
  });
};

// ---- history ----------------------------------------------------------------

let historyMode: "diff" | "full" = "diff";
let shownVersion: Version | null = null;
let versionRequest = 0;

async function openHistory(): Promise<void> {
  if (!current) return;
  const id = current.note.id;
  const dialog = $<HTMLDialogElement>("history");
  const list = $("version-list");
  shownVersion = null;
  renderVersion();
  list.replaceChildren(notice("読み込み中…"));
  dialog.showModal();

  let versions: VersionInfo[];
  try {
    const res = await apiFetch(`/api/notes/${id}/versions`);
    if (!res.ok) throw new Error(String(res.status));
    versions = await res.json();
  } catch {
    list.replaceChildren(notice("履歴を読み込めませんでした。サーバーに接続できるか確認してください。"));
    return;
  }
  if (versions.length === 0) {
    list.replaceChildren(notice("まだ履歴がありません。編集内容は保存されると履歴に残ります。"));
    return;
  }
  const items = versions.map((v, i) => {
    const li = document.createElement("div");
    li.className = "version";
    const when = document.createElement("div");
    when.className = "title";
    when.textContent = formatDate(v.savedAt, true) + (i === 0 ? "（最新）" : "");
    const title = document.createElement("div");
    title.className = "preview";
    title.textContent = `${v.title || "（無題）"} · ${v.length.toLocaleString()} 文字`;
    li.append(when, title);
    li.onclick = () => {
      items.forEach((x) => x.classList.toggle("selected", x === li));
      void showVersion(id, v.id);
    };
    return li;
  });
  list.replaceChildren(...items);
  // The newest version is usually what is on screen; start with the one before it.
  items[Math.min(1, items.length - 1)].click();
}

async function showVersion(noteId: string, versionId: number): Promise<void> {
  const request = ++versionRequest;
  try {
    const res = await apiFetch(`/api/notes/${noteId}/versions/${versionId}`);
    if (!res.ok) throw new Error(String(res.status));
    const version: Version = await res.json();
    if (request !== versionRequest) return;
    shownVersion = version;
  } catch {
    if (request !== versionRequest) return;
    shownVersion = null;
  }
  renderVersion();
}

function renderVersion(): void {
  const box = $("version-text");
  const restore = $<HTMLButtonElement>("restore-version");
  restore.disabled = !shownVersion || !current;
  document.querySelectorAll<HTMLButtonElement>("#history .segmented button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === historyMode);
  });
  if (!shownVersion || !current) {
    $("version-meta").textContent = "";
    box.replaceChildren();
    return;
  }
  const v = shownVersion;
  const tags = v.tags.length ? v.tags.map((t) => `#${t}`).join(" ") : "なし";
  $("version-meta").textContent = `${formatDate(v.savedAt, true)} の版　タグ: ${tags}`;

  const now = current.note.doc.getText("body").toString();
  const diff = historyMode === "diff" ? lineDiff(now, v.body) : null;
  if (historyMode === "diff" && diff && diff.every((d) => d.kind === "same")) {
    box.replaceChildren(notice("現在の本文と同じです"));
    return;
  }
  const lines = diff ?? v.body.split("\n").map((text) => ({ kind: "same" as const, text }));
  const legend = diff
    ? [notice("＋ 戻すと加わる行　− 戻すと消える行")]
    : historyMode === "diff"
      ? [notice("差分を表示するには大きすぎるため、全文を表示しています")]
      : [];
  box.replaceChildren(
    ...legend,
    ...lines.map((d) => {
      const div = document.createElement("div");
      div.className = `line ${d.kind}`;
      div.textContent = d.text || "\u00a0";
      return div;
    }),
  );
}

function notice(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  return el;
}

$("history-note").onclick = () => void openHistory();
$("history-close").onclick = () => $<HTMLDialogElement>("history").close();
document.querySelectorAll<HTMLButtonElement>("#history .segmented button").forEach((b) => {
  b.onclick = () => {
    historyMode = b.dataset.mode as "diff" | "full";
    renderVersion();
  };
});
$("restore-version").onclick = () => {
  if (!current || !shownVersion) return;
  restoreVersion(current.note.doc, shownVersion);
  $<HTMLDialogElement>("history").close();
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
    const res = await apiFetch("/api/export.zip");
    if (!res.ok) throw new Error(String(res.status));
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(await res.blob(), `notes-${stamp}.zip`);
  } catch (e) {
    alert(`書き出しに失敗しました (${e})。サーバーに接続できるか確認してください。`);
  }
};

applyDisplay(loadDisplay());
renderList();
connect();
