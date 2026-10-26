import path from "node:path";

export interface Config {
  port: number;
  dataDir: string;
  authToken: string;
  staticDir: string | null;
  // Edits within this window of a version's start are folded into that version.
  historyIntervalMs: number;
  // Take the client address from X-Forwarded-For (set when behind Caddy).
  trustProxy: boolean;
  authMaxFailures: number;
  authWindowMs: number;
  authLockoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authToken = env.AUTH_TOKEN ?? "";
  if (authToken.length < 16) {
    throw new Error("AUTH_TOKEN must be set (at least 16 characters)");
  }
  return {
    port: Number(env.PORT ?? 8080),
    dataDir: path.resolve(env.DATA_DIR ?? "./data"),
    authToken,
    staticDir: env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : null,
    historyIntervalMs: Number(env.HISTORY_INTERVAL_MINUTES ?? 10) * 60_000,
    trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
    authMaxFailures: Number(env.AUTH_MAX_FAILURES ?? 10),
    authWindowMs: Number(env.AUTH_WINDOW_MINUTES ?? 15) * 60_000,
    authLockoutMs: Number(env.AUTH_LOCKOUT_MINUTES ?? 15) * 60_000,
  };
}
