import { defaultKeymap } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder, drawSelection } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import { ApiError, listDevices, registerDevice, renameThisDevice, revokeDevice } from "./api";
import { countCharacters } from "./count";
import { loadCursor, saveCursor } from "./cursors";
import { createdIn, createdYears, loadExcludedTags, saveExcludedTags, withoutExcluded, type CreatedFilter } from "./listFilter";
import { markers, measureBaseline } from "./markers";
import { bandSelection } from "./selection";
import {
  diaryDate,
  diaryId,
  formatDiaryDate,
  inMonth,
  monthOf,
  renderCalendar,
  today,
  type Month,
} from "./diary";
import { lineDiff, restoreVersion, type Version, type VersionInfo } from "./history";
import { newId, normalizeTag, summarize, type NoteSummary } from "./notes";
import { applyDisplay, loadDisplay, loadSettings, saveDisplay, saveSettings, type RuledLines, type Settings } from "./settings";
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
// Notes created in a year or month, and tags whose notes are left out.
let createdFilter: CreatedFilter = { year: null, month: null };
let excludedTags: string[] = loadExcludedTags();

// The sidebar shows either notes or the diary; the choice is kept per device.
type Mode = "notes" | "diary";
const MODE_KEY = "simple-editor:mode";
let mode: Mode = localStorage.getItem(MODE_KEY) === "diary" ? "diary" : "notes";
let calendarMonth: Month = monthOf(today());

// The note open on this device when the page was last used, reopened at start.
const LAST_NOTE_KEY = "simple-editor:last-note";

function setLastNote(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_NOTE_KEY, id);
    else localStorage.removeItem(LAST_NOTE_KEY);
  } catch {
    // Storage unavailable: the note is simply not reopened.
  }
}

// Opens the note that was open when the page was last used. A diary day opens
// even if nothing was written in it; other notes only if this device knows
// them and they are not in the trash.
function reopenLastNote(): void {
  const id = localStorage.getItem(LAST_NOTE_KEY);
  if (!id || !sync) return;
  const date = diaryDate(id);
  if (date) return void openDiary(date);
  const known = notes.get(id);
  if (!known || known.deleted) return setLastNote(null);
  void selectNote(id);
}

const isDiary = (n: NoteSummary) => diaryDate(n.id) !== null;
// A diary day counts as written once it has some text.
const isWritten = (n: NoteSummary) => n.title !== "";

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
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${settings.serverUrl}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });
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

// Without a search: the notes (or the trash, or a tag), or the month's diary
// entries. A search covers notes and diary entries alike, in either tab.
function visibleNotes(): NoteSummary[] {
  const terms = searchTerms();
  const hits = serverHits();
  const all = [...notes.values()];
  if (terms.length === 0 && mode === "diary") {
    return all
      .filter((n) => isDiary(n) && isWritten(n) && inMonth(diaryDate(n.id)!, calendarMonth))
      .sort((a, b) => b.id.localeCompare(a.id));
  }
  const tag = mode === "notes" ? filterTag : null;
  // The year, month, and excluded tags narrow the notes tab only, and leave
  // diary entries found by a search alone. The trash ignores excluded tags.
  const narrowed = (n: NoteSummary) =>
    mode !== "notes" || isDiary(n) || (createdIn(n.createdAt, createdFilter) && (tag === TRASH || withoutExcluded(n, excludedTags)));
  return all
    .filter((n) => (isDiary(n) ? terms.length > 0 && tag !== TRASH && isWritten(n) : tag === TRASH ? n.deleted : !n.deleted))
    .filter((n) => !tag || tag === TRASH || n.tags.includes(tag))
    .filter(narrowed)
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
    const date = diaryDate(n.id);
    const li = document.createElement("li");
    li.className = (current?.note.id === n.id ? "selected" : "") + (date ? " diary" : "");
    li.onclick = () => void (date ? openDiary(date) : selectNote(n.id));
    const title = document.createElement("div");
    title.className = "title";
    const preview = document.createElement("div");
    preview.className = "preview";
    const snippet = terms.length ? hits?.get(n.id) : undefined;
    if (date) {
      title.textContent = formatDiaryDate(date);
      preview.append(...highlighted(snippet || [n.title, n.preview].filter(Boolean).join(" "), terms));
    } else {
      title.append(...highlighted(n.title || "（無題）", terms));
      preview.append(...highlighted(snippet || n.preview, terms));
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    // In search results diary entries are marked as such; the diary tab needs no mark.
    const kind = date ? (terms.length ? "日記" : "") : formatDate(n.updatedAt);
    meta.textContent = [kind, ...n.tags.map((t) => `#${t}`)].filter(Boolean).join("  ");
    li.append(title, preview, meta);
    return li;
  });
  if (mode === "diary" && terms.length === 0 && items.length === 0) {
    items.push(listNotice("この月の日記はまだありません。カレンダーの日付を選ぶと書けます"));
  }
  if (terms.length && !hits && $("status").dataset.state !== "online") {
    items.push(listNotice("オフラインのため、本文はこの端末で開いているノートだけを検索しています"));
  }
  list.replaceChildren(...items);
  renderTagFilter();
  renderMode();
}

function listNotice(text: string): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "notice";
  li.textContent = text;
  return li;
}

// ---- notes and diary tabs --------------------------------------------------

function setMode(next: Mode): void {
  mode = next;
  localStorage.setItem(MODE_KEY, mode);
  renderList();
}

function renderMode(): void {
  document.body.classList.toggle("mode-diary", mode === "diary");
  document.querySelectorAll<HTMLButtonElement>("#mode-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  const add = $("new-note");
  add.querySelector(".label")!.textContent = mode === "diary" ? "今日" : "新規";
  add.title = mode === "diary" ? "今日の日記" : "新規ノート";
  if (mode !== "diary") return;
  const written = new Set<string>();
  for (const n of notes.values()) {
    const date = diaryDate(n.id);
    if (date && isWritten(n)) written.add(date);
  }
  renderCalendar($("calendar"), {
    month: calendarMonth,
    selected: current ? diaryDate(current.note.id) : null,
    written,
    onPick: (date) => void openDiary(date),
    onMonth: (month) => {
      calendarMonth = month;
      renderList();
    },
  });
}

// Opens the diary entry for a date, switching to the diary tab.
async function openDiary(date: string): Promise<void> {
  calendarMonth = monthOf(date);
  if (mode !== "diary") setMode("diary");
  await selectNote(diaryId(date));
  renderList();
}

function renderTagFilter(): void {
  const tags = new Set<string>();
  for (const n of notes.values()) if (!n.deleted && !isDiary(n)) n.tags.forEach((t) => tags.add(t));
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
  renderListFilter(tags);
}

// The creation year and month, and the tags to leave out.
function renderListFilter(tags: Set<string>): void {
  const memos = [...notes.values()].filter((n) => !isDiary(n));
  const select = (label: string, value: number | null, options: [number, string][], onChange: (v: number | null) => void) => {
    const s = document.createElement("select");
    s.setAttribute("aria-label", label);
    s.className = value === null ? "" : "active";
    s.append(new Option(label, ""), ...options.map(([v, text]) => new Option(text, String(v), false, v === value)));
    s.onchange = () => {
      onChange(s.value === "" ? null : Number(s.value));
      renderList();
    };
    return s;
  };
  const years = createdYears(memos);
  if (createdFilter.year !== null && !years.includes(createdFilter.year)) years.unshift(createdFilter.year);
  const created = document.createElement("span");
  created.className = "filter-group";
  created.append(
    "作成",
    select("すべての年", createdFilter.year, years.map((y) => [y, `${y}年`]), (v) => (createdFilter = { ...createdFilter, year: v })),
    select("すべての月", createdFilter.month, Array.from({ length: 12 }, (_, i) => [i + 1, `${i + 1}月`]), (v) => (createdFilter = { ...createdFilter, month: v })),
  );

  const setExcluded = (next: string[]) => {
    excludedTags = [...new Set(next)].sort();
    saveExcludedTags(excludedTags);
    renderList();
  };
  const excluded = document.createElement("span");
  excluded.className = "filter-group";
  excluded.append("除外");
  for (const t of excludedTags) {
    const chip = document.createElement("span");
    chip.className = "chip excluded";
    const remove = document.createElement("button");
    remove.textContent = "×";
    remove.title = `#${t} の除外をやめる`;
    remove.setAttribute("aria-label", remove.title);
    remove.onclick = () => setExcluded(excludedTags.filter((x) => x !== t));
    chip.append(`#${t}`, remove);
    excluded.append(chip);
  }
  const candidates = [...tags].filter((t) => !excludedTags.includes(t)).sort();
  if (candidates.length > 0) {
    const add = document.createElement("select");
    add.setAttribute("aria-label", "除外するタグ");
    add.append(new Option("＋ タグ", ""), ...candidates.map((t) => new Option(`#${t}`, t)));
    add.onchange = () => add.value && setExcluded([...excludedTags, add.value]);
    excluded.append(add);
  } else if (excludedTags.length === 0) {
    excluded.append(Object.assign(document.createElement("span"), { className: "filter-none", textContent: "タグなし" }));
  }
  $("list-filter").replaceChildren(created, excluded);
}

function formatDate(ms: number, withSeconds = false): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: withSeconds ? "medium" : "short" });
}

// ---- editor ----------------------------------------------------------------

async function selectNote(id: string, isNew = false): Promise<void> {
  if (!sync) return;
  setLastNote(id);
  if (current?.note.id === id) return showEditor();
  closeCurrent();

  const note = await sync.openNote(id);
  sync.active = id;
  const date = diaryDate(id);
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
  // The note opens where the cursor was when it was last left on this device.
  const text = body.toString();
  const saved = isNew ? null : loadCursor(id, text.length);
  const view = new EditorView({
    parent: $("editor"),
    state: EditorState.create({
      doc: text,
      selection: saved ?? undefined,
      extensions: [
        keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
        drawSelection(),
        EditorView.lineWrapping,
        placeholder(date ? "この日の出来事を書きます" : "最初の行がタイトルになります"),
        yCollab(body, provider.awareness, { undoManager }),
        markers,
        bandSelection,
      ],
    }),
  });

  // Record when the user last edited; remote and stored updates are not local.
  // Empty local transactions (one runs as the editor attaches) are not edits.
  let touchTimer: number | undefined;
  const onLocalChange = (tr: Y.Transaction) => {
    if (!tr.local || tr.changed.size === 0 || tr.changed.has(meta as Y.AbstractType<any>)) return;
    clearTimeout(touchTimer);
    // A diary entry is opened without a creation time; writing creates it.
    touchTimer = window.setTimeout(() => {
      doc.transact(() => {
        if (!meta.has("createdAt")) meta.set("createdAt", Date.now());
        meta.set("updatedAt", Date.now());
      });
    }, 500);
  };
  const onAnyChange = () => {
    notes.set(id, summarize(id, doc));
    saveCache();
    renderList();
    renderMeta();
  };
  doc.on("afterTransaction", onLocalChange);
  doc.on("update", onAnyChange);
  // Other devices with this note open (their awareness states).
  sync.announce(note);
  const awareness = provider.awareness;
  const onPresence = () => renderStatus();
  awareness?.on("change", onPresence);

  current = {
    note,
    view,
    dispose: () => {
      rememberCursor();
      clearTimeout(touchTimer);
      doc.off("afterTransaction", onLocalChange);
      doc.off("update", onAnyChange);
      awareness?.off("change", onPresence);
      undoManager.destroy();
      view.destroy();
    },
  };

  // The status below the text: length, who else is editing, and dates.
  function renderStatus() {
    const s = summarize(id, doc);
    const parts = [`${countCharacters(body.toString()).toLocaleString()} 文字`];
    const others = new Set<string>();
    for (const [client, state] of awareness?.getStates() ?? []) {
      const name = (state as { user?: { name?: string } })?.user?.name?.trim();
      // A state this device left behind (another tab, a reload) is not someone else.
      if (client !== awareness?.clientID && name && name !== settings.deviceName) others.add(name);
    }
    if (others.size) parts.push(`編集中: ${[...others].sort().join("、")}`);
    if (date) {
      parts.push(`${formatDiaryDate(date)}の日記`);
      if (meta.has("updatedAt")) parts.push(`更新: ${formatDate(s.updatedAt)}`);
    } else {
      parts.push(`作成: ${formatDate(s.createdAt)}`, `更新: ${formatDate(s.updatedAt)}`);
    }
    $("note-status").textContent = parts.join("　");
  }

  function renderMeta() {
    const s = summarize(id, doc);
    renderStatus();
    const trash = $("trash-note");
    trash.classList.toggle("deleted", s.deleted);
    trash.title = s.deleted ? "ゴミ箱から戻す" : "ゴミ箱へ";
    trash.setAttribute("aria-label", trash.title);
    renderTags(tags);
  }

  document.body.classList.add("has-note");
  document.body.classList.toggle("is-diary", date !== null);
  renderMeta();
  onAnyChange();
  showEditor();
  if (isNew) view.focus();
  // Bring the restored cursor into view once the editor is laid out.
  if (saved) requestAnimationFrame(() => view.dispatch({ effects: EditorView.scrollIntoView(saved.head, { y: "center" }) }));
}

// Saves where the cursor is in the open note.
function rememberCursor(): void {
  if (!current) return;
  const { anchor, head } = current.view.state.selection.main;
  saveCursor(current.note.id, { anchor, head });
}

// The page may be closed or suspended without the note being closed.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rememberCursor();
});
window.addEventListener("pagehide", rememberCursor);

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

function showImportMessage(text: string): void {
  const el = $("import-message");
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
  field("ruledLines").value = display.ruledLines;
  for (const name of DISPLAY_SWITCHES) checkbox(name).checked = display[name];
  showSettingsMessage(message);
  showImportMessage("");
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
  $("import-section").hidden = register;
  $("settings-save").textContent = register ? "登録" : "保存";
}

function describeError(e: unknown): string {
  if (e instanceof ApiError && e.status === 401) return "登録用トークンが違います。";
  if (e instanceof ApiError && e.status === 429) {
    return `失敗が続いたため、一時的に受け付けを停止しています。${Math.ceil(e.retryAfter / 60)} 分ほど待ってから試してください。`;
  }
  if (e instanceof ApiError) return `サーバーでエラーが発生しました (${e.status})。`;
  // The browser does not say whether a certificate was the cause.
  return "サーバーに接続できません。URL とネットワークを確認してください。HTTPS の場合は、この端末でサーバーのルート証明書を信頼しているかも確認してください（サーバーの URL をブラウザで開くと、証明書の警告が出るかどうかで分かります）。";
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
const DISPLAY_SWITCHES = ["showFullWidthSpaces", "showHalfWidthSpaces", "showLineBreaks"] as const;
const checkbox = (name: string) => settingsForm().elements.namedItem(name) as HTMLInputElement;

settingsForm().addEventListener("change", (e) => {
  const name = (e.target as HTMLElement).getAttribute("name") ?? "";
  if (!["fontSize", "lineHeight", "ruledLines", ...DISPLAY_SWITCHES].includes(name)) return;
  const display = {
    fontSize: Number(field("fontSize").value),
    lineHeight: Number(field("lineHeight").value),
    ruledLines: field("ruledLines").value as RuledLines,
    showFullWidthSpaces: checkbox("showFullWidthSpaces").checked,
    showHalfWidthSpaces: checkbox("showHalfWidthSpaces").checked,
    showLineBreaks: checkbox("showLineBreaks").checked,
  };
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
// Going back to the list (narrow screens) leaves the note: not reopened at start.
$("back").onclick = () => {
  document.body.classList.remove("show-editor");
  setLastNote(null);
};

document.querySelectorAll<HTMLButtonElement>("#mode-tabs button").forEach((b) => {
  b.onclick = () => setMode(b.dataset.mode as Mode);
});

$("new-note").onclick = () => {
  if (mode === "diary") return void openDiary(today());
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
  const date = diaryDate(current.note.id);
  downloadBlob(new Blob([body], { type: "text/plain;charset=utf-8" }), date ? `${date}.txt` : safeFileName(s.title));
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

$("import-simplenote").onclick = () => $<HTMLInputElement>("import-file").click();

$<HTMLInputElement>("import-file").onchange = async () => {
  const input = $<HTMLInputElement>("import-file");
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const button = $<HTMLButtonElement>("import-simplenote");
  button.disabled = true;
  showImportMessage(`「${file.name}」を取り込んでいます…`);
  try {
    // The server reads last-line dates as days in this device's time zone.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await apiFetch(`/api/import/simplenote?tz=${encodeURIComponent(tz)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    });
    if (res.status === 400) throw new Error("Simplenote の書き出しファイル（notes.zip か notes.json）ではありません。");
    if (res.status === 413) throw new Error("ファイルが大きすぎます（上限 100 MB）。");
    if (!res.ok) throw new Error(`サーバーでエラーが発生しました (${res.status})。`);
    const r: { total: number; imported: number; skipped: number } = await res.json();
    showImportMessage(
      `${r.imported} 件を取り込みました。` + (r.skipped ? `${r.skipped} 件は取り込み済みのため飛ばしました。` : ""),
    );
    void refreshList();
  } catch (e) {
    showImportMessage(
      `取り込めませんでした。${e instanceof TypeError ? "サーバーに接続できるか確認してください。" : (e as Error).message}`,
    );
  } finally {
    button.disabled = false;
  }
};

applyDisplay(loadDisplay());
measureBaseline($("editor"));
$("build-info").textContent = `build ${__BUILD_NUMBER__}`;
renderList();
connect();
reopenLastNote();
