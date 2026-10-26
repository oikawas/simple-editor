import crypto from "node:crypto";

export const DEVICE_TOKEN_PREFIX = "sed_";

export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

// Device tokens are random, so a plain SHA-256 is enough to store them safely
// and look them up by hash.
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newDeviceToken(): string {
  return DEVICE_TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
}

// The address a request came from. Behind Caddy, the connection itself comes
// from the proxy, which puts the real client last in X-Forwarded-For (Caddy
// replaces any value the client sent unless told to trust it).
export function clientAddress(
  forwardedFor: string | null | undefined,
  remoteAddress: string | null | undefined,
  trustProxy: boolean,
): string {
  const forwarded = trustProxy ? forwardedFor?.split(",").pop()?.trim() : undefined;
  const address = forwarded || remoteAddress || "unknown";
  return address.replace(/^::ffff:/, "");
}

// Counts failed authentication attempts per client address. After
// `maxFailures` within `windowMs`, every attempt from that address is refused
// for `lockoutMs`, valid credentials included, so guessing cannot continue.
export class AuthLimiter {
  private failures = new Map<string, number[]>();
  private lockedUntil = new Map<string, number>();

  constructor(
    private maxFailures: number,
    private windowMs: number,
    private lockoutMs: number,
    private now: () => number = Date.now,
  ) {}

  // Milliseconds until the address may try again; 0 when it is not locked out.
  retryAfter(address: string): number {
    const until = this.lockedUntil.get(address);
    if (until === undefined) return 0;
    const left = until - this.now();
    if (left > 0) return left;
    this.lockedUntil.delete(address);
    return 0;
  }

  // Records a failure and reports whether the address is now locked out.
  fail(address: string): boolean {
    const now = this.now();
    const recent = (this.failures.get(address) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    if (recent.length >= this.maxFailures) {
      this.failures.delete(address);
      this.lockedUntil.set(address, now + this.lockoutMs);
      return true;
    }
    this.failures.set(address, recent);
    this.prune(now);
    return false;
  }

  succeed(address: string): void {
    this.failures.delete(address);
  }

  private prune(now: number): void {
    if (this.failures.size < 1000) return;
    for (const [address, times] of this.failures) {
      if (times.every((t) => now - t >= this.windowMs)) this.failures.delete(address);
    }
  }
}
