import { timingSafeEqual } from "node:crypto";

/**
 * Token gate for the self-hosted iCal feed ("token-gated"). The token
 * is per-deployment (one shared team feed) and configured via the
 * `ICAL_FEED_TOKEN` env var. The route is public-but-token-gated because
 * calendar clients (Outlook/Apple) subscribe without sending auth cookies.
 */

/** Read the configured feed token; throws clearly if unset when actually used. */
export function getFeedToken(): string {
  const token = process.env.ICAL_FEED_TOKEN;
  if (!token) {
    throw new Error(
      "ICAL_FEED_TOKEN is not set — generate a long random token and set it before subscribing calendar clients.",
    );
  }
  return token;
}

/**
 * Constant-time comparison so a mismatch never leaks timing signal about how
 * much of the token matched. `expected` is the configured token; `presented` is
 * what the URL carried.
 */
export function tokenMatches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) {
    // Compare b against itself to keep the work constant regardless of length.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
