import { isIP } from "node:net";

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
  /**
   * Cap on tracked keys per kind (emails, IPs). Past it, the least recently used
   * key that is not locked is dropped first. Values below one are raised to one:
   * the key being recorded always stays.
   */
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
 * The throttle key for a client address. IPv4 is used as it is. An IPv4-mapped
 * IPv6 address counts as its IPv4 address. Any other IPv6 address collapses to
 * its /64: one client normally controls a whole /64, so keying on the full
 * address would give an attacker a fresh key per request. Anything that does
 * not parse keeps its trimmed text, bounded.
 */
export function normalizeClientIp(raw: string): string {
  const text = raw.trim();
  const bracketed = /^\[([^\]]*)\](?::\d{1,5})?$/.exec(text);
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(text);
  let address = bracketed ? bracketed[1]! : v4WithPort ? v4WithPort[1]! : text;
  // A zone id (fe80::1%eth0) names the interface, not the host.
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);

  const family = isIP(address);
  if (family === 4) return address;
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (groups) {
      const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
      if (mapped) {
        const [high, low] = [groups[6]!, groups[7]!];
        return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      }
      return `${groups
        .slice(0, 4)
        .map((group) => group.toString(16))
        .join(":")}::/64`;
    }
  }
  return text.slice(0, MAX_IP_LENGTH);
}

/** The eight 16-bit groups of a valid IPv6 address, or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  // A dotted tail (::ffff:192.0.2.1) stands for the last two groups.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return null;
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [
    ...head,
    ...Array<string>(halves.length === 2 ? missing : 0).fill("0"),
    ...rest,
  ].map((part) => (/^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : Number.NaN));
  return groups.length === 8 && groups.every((group) => !Number.isNaN(group)) ? groups : null;
}

/**
 * The client address as the single trusted proxy saw it, normalised for use as
 * a throttle key. Production sits behind exactly one proxy (Caddy; Express
 * `trust proxy` is 1), which appends the address it received the connection
 * from, so the right-most entry is the only one a client cannot forge. React
 * Router's `Request` does not carry Express's `req.ip`. Without the header
 * (development, direct access) there is no IP key.
 */
export function clientIpFromHeaders(headers: Headers | null | undefined): string | null {
  const forwarded = headers?.get("x-forwarded-for");
  if (!forwarded) return null;
  const last = forwarded.split(",").pop()?.trim();
  return last ? normalizeClientIp(last) : null;
}

type Bucket = Map<string, number[]>;

export function createLoginThrottle(options: LoginThrottleOptions = {}) {
  const maxEmailFailures = options.maxEmailFailures ?? LOGIN_MAX_EMAIL_FAILURES;
  const maxIpFailures = options.maxIpFailures ?? LOGIN_MAX_IP_FAILURES;
  const windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
  const maxKeys = Math.max(1, Math.floor(options.maxKeys ?? DEFAULT_MAX_KEYS));
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

  /** Whether the key is refused right now: `limit` failures still inside the window. */
  function isLocked(stamps: number[], limit: number, at: number): boolean {
    return stamps.length >= limit && stamps[stamps.length - limit]! > at - windowMs;
  }

  /**
   * Makes room by dropping the least recently used key that is not locked. A
   * lock is a single entry, so evicting it would hand an attacker who floods the
   * map with junk keys a fresh set of guesses on the locked account. Only when
   * every other key is locked does a lock go, the one that runs out soonest
   * (the first in map order on a tie). The scan stops at the first key that is
   * not locked and never passes `maxKeys` entries, each checked in O(1). Called
   * only while the bucket holds more than `maxKeys` (at least one) keys, so there
   * is always a key other than `keep` to drop.
   */
  function evictOne(bucket: Bucket, limit: number, at: number, keep: string) {
    let soonest: string | undefined;
    let soonestExpiry = Number.POSITIVE_INFINITY;
    for (const [key, stamps] of bucket) {
      if (key === keep) continue;
      if (!isLocked(stamps, limit, at)) {
        bucket.delete(key);
        return;
      }
      const expiry = stamps[stamps.length - limit]! + windowMs;
      if (expiry < soonestExpiry) {
        soonest = key;
        soonestExpiry = expiry;
      }
    }
    if (soonest !== undefined) bucket.delete(soonest);
  }

  function record(bucket: Bucket, key: string, limit: number, at: number) {
    const stamps = live(bucket, key, at);
    stamps.push(at);
    // Re-inserting keeps Map order = least recently used first.
    bucket.delete(key);
    bucket.set(key, stamps);
    while (bucket.size > maxKeys) evictOne(bucket, limit, at, key);
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
      // Email failures are keyed by the email+IP PAIR, never by email alone:
      // an unauthenticated caller must not be able to lock a known victim's
      // email — with an email-only key, ten bad guesses from one address would
      // reject even the victim's correct password until the window slides.
      // Pair-keying keeps brute-force pressure per source address (the IP
      // bucket still caps the address overall) without a cross-IP lockout.
      const emailKey = email
        ? ip
          ? `${email}
${ip}`
          : email
        : null;
      const emailStamps = emailKey ? live(emails, emailKey, at) : [];
      const ipStamps = ip ? live(ips, ip, at) : [];

      let retryAfterMs = 0;
      if (email && emailStamps.length >= maxEmailFailures) {
        retryAfterMs = Math.max(retryAfterMs, retryAfter(emailStamps, maxEmailFailures, at));
      }
      if (ip && ipStamps.length >= maxIpFailures) {
        retryAfterMs = Math.max(retryAfterMs, retryAfter(ipStamps, maxIpFailures, at));
      }
      if (retryAfterMs > 0) return { allowed: false, retryAfterMs };

      if (emailKey) record(emails, emailKey, maxEmailFailures, at);
      if (ip) record(ips, ip, maxIpFailures, at);
      return { allowed: true };
    },

    /** A correct password clears the email+IP pair's failures and refunds this attempt on the IP. */
    succeeded(attempt: LoginAttempt): void {
      const emailKey =
        attempt.email && attempt.ip
          ? `${attempt.email}
${attempt.ip}`
          : attempt.email;
      if (emailKey) emails.delete(emailKey);
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
