export interface Settings {
  serverUrl: string;
  token: string;
  deviceName: string;
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
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      serverUrl: s.serverUrl || location.origin,
      token: s.token ?? "",
      deviceName: s.deviceName || defaultDeviceName(),
    };
  } catch {
    return { serverUrl: location.origin, token: "", deviceName: defaultDeviceName() };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify({ ...s, serverUrl: s.serverUrl.replace(/\/+$/, "") }));
}

export function syncUrl(s: Settings): string {
  return s.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/sync";
}
