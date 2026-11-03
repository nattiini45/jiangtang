import { z } from "zod";
import { localizeMessage } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import { currentLocale, tr } from "~/i18n/request-locale.server";
import { logger } from "~/lib/observability/logger.server";

/**
 * Canonical error → HTTP mapping. Loaders/actions may THROW these
 * (or a Response) and the route ErrorBoundary / `toErrorResponse` renders them.
 */

export type FieldErrors = Record<string, string[]>;

/** Field errors whose messages may still be catalog keys (zod schemas carry keys, see `msgKey`). */
export function localizeFieldErrors(locale: Locale, fieldErrors: FieldErrors): FieldErrors {
  return Object.fromEntries(
    Object.entries(fieldErrors).map(([field, messages]) => [
      field,
      (messages ?? []).map((m) => localizeMessage(locale, m)),
    ]),
  );
}

export function localizeMessages(locale: Locale, messages: string[]): string[] {
  return messages.map((m) => localizeMessage(locale, m));
}

/** 422 — a Zod/form validation failure, with per-field messages. */
export class ValidationError extends Error {
  readonly fieldErrors: FieldErrors;
  readonly formErrors: string[];
  constructor(fieldErrors: FieldErrors, formErrors: string[] = []) {
    super("Validation failed");
    this.name = "ValidationError";
    this.fieldErrors = fieldErrors;
    this.formErrors = formErrors;
  }
}

/** 404 — an entity could not be found. */
export class NotFoundError extends Error {
  constructor(message = tr("err.notFound")) {
    super(message);
    this.name = "NotFoundError";
  }
}

/** 409 — a booking/allocation overlaps an existing one (DB raised 23P01). */
export class BookingConflictError extends Error {
  constructor(message = tr("err.bookingConflict")) {
    super(message);
    this.name = "BookingConflictError";
  }
}

const SQLSTATE_EXCLUSION_VIOLATION = "23P01";

/**
 * Walks an error (and its `.cause` chain) for a given Postgres SQLSTATE code or Prisma code.
 *
 * `@prisma/adapter-pg` 7.10 reports the SQLSTATE of a driver failure at
 * `meta.driverAdapterError.cause.originalCode`, so that path is checked as well: a Restrict
 * violation arrives as Prisma `P2003` whose adapter cause carries `23001`.
 */
export function hasSqlState(error: unknown, code: string): boolean {
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 6; depth++) {
    const e = cur as {
      code?: unknown;
      meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
      message?: unknown;
      cause?: unknown;
    };
    if (e.code === code) return true;
    if (e.meta && e.meta.code === code) return true;
    if (e.meta?.driverAdapterError?.cause?.originalCode === code) return true;
    if (typeof e.message === "string" && e.message.includes(code)) return true;
    cur = e.cause;
  }
  return false;
}

export function isExclusionViolation(error: unknown): boolean {
  return hasSqlState(error, SQLSTATE_EXCLUSION_VIOLATION);
}

/** JSON Response body shape for error responses. */
export interface ErrorBody {
  error: string;
  message: string;
  fieldErrors?: FieldErrors;
  formErrors?: string[];
}

function json(body: ErrorBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Map any thrown value to a Response:
 *   ZodError / ValidationError → 422
 *   BookingConflictError or raw 23P01 → 409
 *   NotFoundError → 404
 *   an already-formed Response → passthrough
 *   else → 500
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof Response) return error;

  if (error instanceof z.ZodError) {
    const flat = z.flattenError(error);
    const locale = currentLocale();
    return json(
      {
        error: "ValidationError",
        message: tr("err.validationFailed"),
        fieldErrors: localizeFieldErrors(locale, flat.fieldErrors as FieldErrors),
        formErrors: localizeMessages(locale, flat.formErrors),
      },
      422,
    );
  }

  if (error instanceof ValidationError) {
    const locale = currentLocale();
    return json(
      {
        error: "ValidationError",
        message: tr("err.validationFailed"),
        fieldErrors: localizeFieldErrors(locale, error.fieldErrors),
        formErrors: localizeMessages(locale, error.formErrors),
      },
      422,
    );
  }

  if (error instanceof BookingConflictError || isExclusionViolation(error)) {
    // BookingConflictError carries an intended, user-facing message. A raw 23P01
    // exclusion violation that didn't go through BookingConflictError is an
    // unexpected shape (e.g. a constraint we don't recognize) — treat it like the
    // 500 branch below and don't leak the raw DB error message to the client.
    if (error instanceof BookingConflictError) {
      return json({ error: "BookingConflictError", message: error.message }, 409);
    }
    return json(internalErrorBody(error), 409);
  }

  if (error instanceof NotFoundError) {
    return json({ error: "NotFoundError", message: error.message }, 404);
  }

  return json(internalErrorBody(error), 500);
}

/**
 * Builds the response body for an unexpected (raw) exception. In production
 * the client only ever sees a generic message plus a correlation id; the real
 * error (with that same id) is logged server-side so it's still recoverable. In
 * non-production the detailed message is kept for DX.
 */
function internalErrorBody(error: unknown): ErrorBody {
  if (process.env.NODE_ENV === "production") {
    const correlationId = crypto.randomUUID();
    logger.error({ err: error, correlationId }, "Unhandled error mapped to a generic response");
    return {
      error: "InternalServerError",
      message: tr("err.internalRef", { ref: correlationId }),
    };
  }
  const message = error instanceof Error ? error.message : tr("err.internal");
  return { error: "InternalServerError", message };
}
