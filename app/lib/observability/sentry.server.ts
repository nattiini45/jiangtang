import * as Sentry from "@sentry/node";
import { redactTokenSegments } from "~/lib/observability/logger.server";

/**
 * Error tracking. @sentry/node is wire-compatible with a
 * self-hosted GlitchTip instance via the `GLITCHTIP_DSN` env var (Sentry-protocol).
 * Initialized once by the observability boot module; no-op (init returns early
 * when DSN is unset) so dev runs without GlitchTip are unaffected.
 */

let initialized = false;

// Request headers that carry the client address. A reverse proxy in front of the app
// sets these, and they are personal data, so they are dropped before the event leaves.
const IP_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "cf-connecting-ip",
  "true-client-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "fastly-client-ip",
  "client-ip",
];

// Span attributes whose names say they hold a URL or a path. Matching by name keeps the
// redaction away from database statements and other values.
const URL_KEY = /url|target|referer|path/i;

type SpanLike = { description?: string; data?: Record<string, unknown> };

/**
 * Drops the query string and fragment, which can carry search text, then replaces the
 * token segment of the iCal feed and invite links as the request logger does.
 */
function scrubUrl(url: string): string {
  return redactTokenSegments(url.replace(/[?#][\s\S]*$/, ""));
}

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubUrl(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  return value;
}

/**
 * Errors and transactions. The request-data integration attaches the request URL and
 * referer to both, and the span hook below never sees them.
 */
function redactRequestFields(event: {
  transaction?: string;
  request?: Sentry.RequestEventData;
}): void {
  if (event.transaction) event.transaction = redactTokenSegments(event.transaction);
  const request = event.request;
  if (request?.url) request.url = scrubUrl(request.url);
  if (request?.headers?.referer) request.headers.referer = scrubUrl(request.headers.referer);
}

/**
 * The root span and each child span of a transaction, and standalone spans. The root span
 * name repeats the request path, so it carries the token too.
 */
function redactSpan(span: SpanLike): void {
  if (span.description) span.description = redactTokenSegments(span.description);
  const data = span.data;
  if (!data) return;
  for (const key of Object.keys(data)) {
    if (URL_KEY.test(key)) data[key] = scrubValue(data[key]);
  }
}

function redactBreadcrumb(breadcrumb: Sentry.Breadcrumb): void {
  const data = breadcrumb.data;
  if (!data) return;
  for (const key of ["url", "from", "to"]) {
    if (key in data) data[key] = scrubValue(data[key]);
  }
}

export function initSentry(): void {
  const dsn = process.env.GLITCHTIP_DSN;
  if (!dsn || initialized) return;
  initialized = true;
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    // Sampling: capture all errors; traces are light (internal tool, low traffic).
    tracesSampleRate: 0.2,
    // GlitchTip stores transactions but ignores the streamed span envelopes that
    // SDK v11 sends by default, so the static transaction model keeps traces visible.
    traceLifecycle: "static",
    // GDPR: never send PII to the error tracker. SDK v11 collects user info, cookies,
    // HTTP bodies, database query data and URL query strings, and local variables unless
    // each is switched off here.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpBodies: [],
      httpHeaders: { request: { deny: IP_HEADERS } },
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    },
    // The iCal feed and the invite link carry their secret in the path. Every field that
    // can hold a URL or path is redacted before it leaves, as the request logger does.
    beforeSend: (event) => {
      redactRequestFields(event);
      return event;
    },
    // The request fields above sit on the transaction event, which beforeSendSpan does not
    // see, so transactions need this hook as well.
    beforeSendTransaction: (event) => {
      redactRequestFields(event);
      return event;
    },
    beforeSendSpan: Sentry.withStaticSpan((span) => {
      redactSpan(span);
      return span;
    }),
    beforeBreadcrumb: (breadcrumb) => {
      redactBreadcrumb(breadcrumb);
      return breadcrumb;
    },
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
