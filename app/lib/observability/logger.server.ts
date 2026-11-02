import pino from "pino";

/**
 * Structured logger. Pino with JSON output, Europe/Berlin
 * timestamps, and redaction of secret-bearing fields. A child logger per request
 * carries a request-id (set by the observability boot module's middleware).
 *
 * Server-only (`.server.ts` suffix). The level is `LOG_LEVEL` (default `info`).
 */

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";

export const logger = pino({
  level: LOG_LEVEL,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    // Never log secrets — match env var names + common header keys. Pino's `*`
    // wildcard only matches ONE level, so `*.password` matches `user.password`
    // but NOT a top-level `{ password }` — list the bare key too for every path
    // so a secret logged at the root of the object is still censored.
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "authorization",
      "cookie",
      "password",
      "*.password",
      "secret",
      "*.secret",
      "token",
      "*.token",
      "BETTER_AUTH_SECRET",
      "*.BETTER_AUTH_SECRET",
      "STORAGE_ENCRYPTION_KEY",
      "*.STORAGE_ENCRYPTION_KEY",
      "GLITCHTIP_DSN",
      "*.GLITCHTIP_DSN",
      "DATABASE_URL",
      "*.DATABASE_URL",
    ],
    censor: "[redacted]",
  },
});

/**
 * Replaces the token segment of token-bearing routes (the iCal feed and the invite
 * link) so a request log line never carries the token. Other paths and the query
 * string are returned unchanged.
 */
const TOKEN_SEGMENT = /(\/(?:calendar|accept-invite)\/)[^/?#]+/gi;

export function redactTokenSegments(url: string): string {
  return url.replace(TOKEN_SEGMENT, "$1:token");
}

/** Create a request-scoped child logger carrying a request id. */
export function requestLogger(requestId: string, method: string, url: string) {
  return logger.child({ requestId, method, url });
}
