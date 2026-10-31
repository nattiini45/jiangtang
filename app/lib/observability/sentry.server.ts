import * as Sentry from "@sentry/node";

/**
 * Error tracking. @sentry/node is wire-compatible with a
 * self-hosted GlitchTip instance via the `GLITCHTIP_DSN` env var (Sentry-protocol).
 * Initialized once by the observability boot module; no-op (init returns early
 * when DSN is unset) so dev runs without GlitchTip are unaffected.
 */

let initialized = false;

export function initSentry(): void {
  const dsn = process.env.GLITCHTIP_DSN;
  if (!dsn || initialized) return;
  initialized = true;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    // Sampling: capture all errors; traces are light (internal tool, low traffic).
    tracesSampleRate: 0.2,
    sendDefaultPii: false, // GDPR: never send PII to the error tracker
  });
}

export function captureException(error: unknown): void {
  if (!initialized) return;
  Sentry.captureException(error);
}

export async function flushSentry(timeoutMillis = 2000): Promise<void> {
  if (!initialized) return;
  await Sentry.close(timeoutMillis);
}
