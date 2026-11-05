/**
 * Failed-sign-in throttle for the email/password login.
 *
 * Better Auth's own rate limiter lives in its HTTP router and is skipped for
 * `auth.api.*` calls, which is what the login form uses. This one is wired in as
 * a Better Auth hook, so the form and `/api/auth/sign-in/email` share it.
 *
 * State is in memory and per process: the app is a single Node process, and a
 * restart only forgives the attackers it was already holding back. Every
 * structure is bounded (timestamps per key by the limit, keys by `maxKeys`).
 */

export type LoginThrottleOptions = {
  /** Failed attempts allowed per normalised email inside the window. */
  maxEmailFailures?: number;
  /** Failed attempts allowed per client IP inside the window. */
  maxIpFailures?: number;
  windowMs?: number;
  /** Cap on tracked keys per kind (emails, IPs); the least recently used key is dropped first. */
  maxKeys?: number;
  /** Injectable for tests. */
  now?: () => number;
};

export type LoginAttempt = { email: string | null; ip: string | null };

export type LoginThrottleDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_EMAIL_FAILURES = 10;
export const LOGIN_MAX_IP_FAILURES = 30;
const DEFAULT_MAX_KEYS = 10_000;
const SWEEP_INTERVAL_MS = 60 * 1000;
// Longer than any real address (RFC 5321 caps the path at 254), so a hostile
// field cannot make every key arbitrarily large.
const MAX_EMAIL_KEY_LENGTH = 320;
const MAX_IP_LENGTH = 64;

export function normalizeLoginEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email ? email.slice(0, MAX_EMAIL_KEY_LENGTH) : null;
}

/**
 * The client address as the single trusted proxy saw it. Production sits behind
 * exactly one proxy (Caddy; Express `trust proxy` is 1), which appends the
 * address it received the connection from, so the right-most entry is the only
 * one a client cannot forge. React Router's `Request` does not carry Express's
 * `req.ip`. Without the header (development, direct access) there is no IP key.
 */
export function clientIpFromHeaders(headers: Headers | null | undefined): string | null {
  const forwarded = headers?.get("x-forwarded-for");
  if (!forwarded) return null;
  const last = forwarded.split(",").pop()?.trim();
  return last ? last.slice(0, MAX_IP_LENGTH) : null;
}

type Bucket = Map<string, number[]>;

export function createLoginThrottle(options: LoginThrottleOptions = {}) {
  const maxEmailFailures = options.maxEmailFailures ?? LOGIN_MAX_EMAIL_FAILURES;
  const maxIpFailures = options.maxIpFailures ?? LOGIN_MAX_IP_FAILURES;
  const windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? Date.now;

  const emails: Bucket = new Map();
  const ips: Bucket = new Map();
  let lastSweep = now();

  /** Timestamps still inside the rolling window; drops the key when none are left. */
  function live(bucket: Bucket, key: string, at: number): number[] {
    const stamps = bucket.get(key);
    if (!stamps) return [];
    const fresh = stamps.filter((stamp) => stamp > at - windowMs);
    if (fresh.length === stamps.length) return stamps;
    if (fresh.length === 0) bucket.delete(key);
    else bucket.set(key, fresh);
    return fresh;
  }

  function sweep(at: number) {
    if (at - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = at;
    for (const bucket of [emails, ips]) {
      for (const key of [...bucket.keys()]) live(bucket, key, at);
    }
  }

  function record(bucket: Bucket, key: string, at: number) {
    const stamps = live(bucket, key, at);
    stamps.push(at);
    // Re-inserting keeps Map order = least recently used first.
    bucket.delete(key);
    bucket.set(key, stamps);
    while (bucket.size > maxKeys) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
  }

  function retryAfter(stamps: number[], limit: number, at: number): number {
    // The window frees a slot when the oldest counted failure ages out.
    return Math.max(1, stamps[stamps.length - limit]! + windowMs - at);
  }

  return {
    /**
     * Asks whether a sign-in attempt may proceed and, if so, counts it as a
     * failure right away. Counting before the password check keeps concurrent
     * guesses from all slipping under the limit; `succeeded` takes it back.
     * A refused attempt is not counted, so hammering a locked key cannot extend
     * the lockout.
     */
    begin(attempt: LoginAttempt): LoginThrottleDecision {
      const at = now();
      sweep(at);
      const email = attempt.email;
      const ip = attempt.ip;
      const emailStamps = email ? live(emails, email, at) : [];
      const ipStamps = ip ? live(ips, ip, at) : [];

      let retryAfterMs = 0;
      if (email && emailStamps.length >= maxEmailFailures) {
        retryAfterMs = Math.max(retryAfterMs, retryAfter(emailStamps, maxEmailFailures, at));
      }
      if (ip && ipStamps.length >= maxIpFailures) {
        retryAfterMs = Math.max(retryAfterMs, retryAfter(ipStamps, maxIpFailures, at));
      }
      if (retryAfterMs > 0) return { allowed: false, retryAfterMs };

      if (email) record(emails, email, at);
      if (ip) record(ips, ip, at);
      return { allowed: true };
    },

    /** A correct password clears the email's failures and refunds this attempt on the IP. */
    succeeded(attempt: LoginAttempt): void {
      if (attempt.email) emails.delete(attempt.email);
      if (attempt.ip) {
        const stamps = live(ips, attempt.ip, now());
        stamps.pop();
        if (stamps.length === 0) ips.delete(attempt.ip);
      }
    },

    /** Forgets everything. For tests. */
    reset(): void {
      emails.clear();
      ips.clear();
      lastSweep = now();
    },

    /** Number of tracked keys, for tests of the memory bound. */
    size(): { emails: number; ips: number } {
      return { emails: emails.size, ips: ips.size };
    },
  };
}

export type LoginThrottle = ReturnType<typeof createLoginThrottle>;

/** The process-wide instance used by the Better Auth hooks. */
export const loginThrottle: LoginThrottle = createLoginThrottle();
