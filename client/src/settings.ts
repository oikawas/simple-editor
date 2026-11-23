export interface Settings {
  serverUrl: string;
  // This device's own token, issued at registration. Empty until registered.
  deviceToken: string;
  deviceId: string;
  deviceName: string;
  // Before per-device tokens the registration token itself was stored here;
  // it is exchanged for a device token on startup and then dropped.
  legacyToken: string;
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  return "ブラウザ";
}

const KEY = "simple-editor:settings";

export function loadSettings(): Settings {
  let s: Record<string, string> = {};
  try {
    s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    // Unreadable settings: start over.
  }
  return {
    serverUrl: s.serverUrl || location.origin,
    deviceToken: s.deviceToken ?? "",
    deviceId: s.deviceId ?? "",
    deviceName: s.deviceName || defaultDeviceName(),
    legacyToken: s.deviceToken ? "" : (s.token ?? ""),
  };
}

export function saveSettings(s: Settings): void {
  const { legacyToken, ...rest } = s;
  const stored: Record<string, string> = { ...rest, serverUrl: s.serverUrl.replace(/\/+$/, "") };
  if (legacyToken) stored.token = legacyToken;
  localStorage.setItem(KEY, JSON.stringify(stored));
}

// Per-device display preferences.
export interface Display {
  fontSize: number;
  // Line height as a multiple of the font size.
  lineHeight: number;
  // A rule under every line of the text, and its style.
  ruledLines: RuledLines;
  // Marks for full-width spaces, half-width spaces, and line breaks.
  showFullWidthSpaces: boolean;
  showHalfWidthSpaces: boolean;
  showLineBreaks: boolean;
}

export type RuledLines = "none" | "solid" | "dashed" | "dotted";
const RULED_LINES: RuledLines[] = ["none", "solid", "dashed", "dotted"];

const DISPLAY_KEY = "simple-editor:display";
export const DEFAULT_FONT_SIZE = 15;
export const DEFAULT_LINE_HEIGHT = 1.6;

export function loadDisplay(): Display {
  try {
    const d = JSON.parse(localStorage.getItem(DISPLAY_KEY) ?? "{}");
    const size = Number(d.fontSize);
    const height = Number(d.lineHeight);
    return {
      fontSize: size >= 8 && size <= 48 ? size : DEFAULT_FONT_SIZE,
      lineHeight: height >= 1 && height <= 3 ? height : DEFAULT_LINE_HEIGHT,
      ruledLines: RULED_LINES.includes(d.ruledLines) ? d.ruledLines : "none",
      showFullWidthSpaces: d.showFullWidthSpaces === true,
      showHalfWidthSpaces: d.showHalfWidthSpaces === true,
      showLineBreaks: d.showLineBreaks === true,
    };
  } catch {
    return defaultDisplay();
  }
}

export function defaultDisplay(): Display {
  return {
    fontSize: DEFAULT_FONT_SIZE,
    lineHeight: DEFAULT_LINE_HEIGHT,
    ruledLines: "none",
    showFullWidthSpaces: false,
    showHalfWidthSpaces: false,
    showLineBreaks: false,
  };
}

export function saveDisplay(d: Display): void {
  localStorage.setItem(DISPLAY_KEY, JSON.stringify(d));
}

export function applyDisplay(d: Display): void {
  document.documentElement.style.setProperty("--editor-font-size", `${d.fontSize}px`);
  document.documentElement.style.setProperty("--editor-line-height", String(d.lineHeight));
  // The editor's marks are always there; these attributes make them visible.
  const root = document.documentElement.dataset;
  if (d.ruledLines === "none") delete root.ruledLines;
  else root.ruledLines = d.ruledLines;
  const flag = (name: "fullWidthSpaces" | "halfWidthSpaces" | "lineBreaks", on: boolean) => {
    if (on) root[name] = "";
    else delete root[name];
  };
  flag("fullWidthSpaces", d.showFullWidthSpaces);
  flag("halfWidthSpaces", d.showHalfWidthSpaces);
  flag("lineBreaks", d.showLineBreaks);
}

export function syncUrl(s: Settings): string {
  return s.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/sync";
}
