import { z } from "zod";
import { msgKey } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import { resolveLocale } from "~/i18n/locale.server";
import { currentLocale } from "~/i18n/request-locale.server";
import {
  ValidationError,
  localizeFieldErrors,
  localizeMessages,
  type FieldErrors,
} from "~/lib/errors.server";

/**
 * Form parsing bound to the error conventions. `parseForm` throws a
 * `ValidationError` (→ 422 via toErrorResponse) on failure; `safeParseForm`
 * returns a discriminated result for actions that render inline field errors.
 */

export type { FieldErrors };

/**
 * `undefined` on empty-string input; otherwise trims and requires a well-formed
 * http(s) URL. Zod's bare `.url()` accepts any scheme (`javascript:`, `data:`,
 * ...) which is a stored-XSS vector wherever the value is later rendered as an
 * `<a href>`. Use this for any optional URL field instead of hand-rolling `.url()`.
 */
export const optionalHttpUrl = z.preprocess(
  (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .trim()
    .url(msgKey("err.url.invalid"))
    .refine((u) => /^https?:\/\//i.test(u), msgKey("err.url.httpOnly"))
    .optional(),
);

/**
 * Validate a query-string value against a Prisma enum const object. Uses an
 * own-VALUES check, never the `in` operator — `raw in EnumObj` also matches
 * inherited Object.prototype keys, so `?status=toString` would pass a bogus
 * value straight into a Prisma enum filter and 500 the loader.
 */
export function parseEnumParam<T extends Record<string, string>>(
  enumObj: T,
  raw: string | null,
): T[keyof T] | undefined {
  if (!raw) return undefined;
  return (Object.values(enumObj) as string[]).includes(raw) ? (raw as T[keyof T]) : undefined;
}

/** FormData → plain object. Repeated keys collapse to an array (multi-select, checkboxes). */
export function formDataToObject(formData: FormData): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const [key, value] of formData.entries()) {
    // Skip File entries here — attachment handling lives in the storage track.
    const v = typeof value === "string" ? value : undefined;
    if (key in obj) {
      const existing = obj[key];
      if (Array.isArray(existing)) existing.push(v);
      else obj[key] = [existing, v];
    } else {
      obj[key] = v;
    }
  }
  return obj;
}

/**
 * 🔴 **The `tags` normaliser — moved here verbatim from the stock form,
 * and the reason the form does not render per-tag errors.**
 *
 * `formDataToObject` collapses repeated keys, so N inputs named `tags` arrive as an array
 * of N values and **one** input arrives as a bare string. Both are handled here rather than
 * in the schema, because the schema is shared with the CSV importer and a form-only
 * concern does not belong in it.
 *
 * | inputs named `tags` | raw            | after this function        |
 * |---|---|---|
 * | 0 (form omits the control) | key absent | **`carried`** — the caller's value |
 * | 1 | `"kabel"` (a string) | `["kabel"]` — the bare-string case, which `z.array()` alone REJECTS |
 * | N, some blank | `["kabel", ""]` | `["kabel"]` — a blank box deletes that tag |
 * | N, some whitespace | `["kabel", "  "]` | `["kabel"]` — `trim()` decides, not a length check |
 *
 * ⚠️ **The single-input case is the one a control written only for 2+ would miss.** Measured
 * 2026-10-06 through the real `formDataToObject` + the real `stockCreateSchema`: a create
 * form with one blank box sends `"kabel"` as a **bare string**, and `z.array()` alone
 * rejects it as *"Expected array, received string"*. So a filter written as
 * `Array.isArray(x) ? … : [x]` is what turns a green multi-tag test into a working
 * single-tag form — and the create form sends EXACTLY ONE input, because there is no
 * "add tag" button (`stock-form-fields.tsx`). It is the shape a user reaches first.
 *
 * ⚠️ **This lives here, not in the schema, and the two callers are the reason.**
 * `stockCreateSchema.tags` is `z.array(z.string().trim().min(1)).default([])` and stays
 * exactly that: a schema-level coercion would make the CSV import **accept** a `tags`
 * column and silently reverse the importer's shipped decision, which the UI states in words
 * (*"`tags` ist keine Spalte, weil eine Zelle keine Liste ist"*). The fix therefore has to
 * live **where a `FormData` exists** — and there are two such places, so the rule is
 * written once, here, beside the `formDataToObject` both callers already import.
 */
export function tagsFromForm(form: FormData, carried: string[]): string[] {
  const raw = formDataToObject(form).tags;
  const list = raw === undefined ? carried : Array.isArray(raw) ? raw : [raw];
  return list.filter((t): t is string => typeof t === "string" && t.trim() !== "");
}

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; fieldErrors: FieldErrors; formErrors: string[] };

/** Messages come out in `locale` (default: the current request's); schemas carry catalog keys. */
export function safeParse<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  locale: Locale = currentLocale(),
): ParseResult<z.infer<S>> {
  const result = schema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  const flat = result.error.flatten();
  return {
    success: false,
    fieldErrors: localizeFieldErrors(locale, flat.fieldErrors as FieldErrors),
    formErrors: localizeMessages(locale, flat.formErrors),
  };
}

export async function safeParseForm<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<ParseResult<z.infer<S>>> {
  const formData = await request.formData();
  return safeParse(schema, formDataToObject(formData), resolveLocale(request));
}

/** Parse a Request's form body, THROWING ValidationError on failure (→ 422). */
export async function parseForm<S extends z.ZodTypeAny>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  const result = await safeParseForm(request, schema);
  if (!result.success) throw new ValidationError(result.fieldErrors, result.formErrors);
  return result.data;
}

/** Parse already-extracted input (e.g. URL search params object), throwing on failure. */
export function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const result = safeParse(schema, input);
  if (!result.success) throw new ValidationError(result.fieldErrors, result.formErrors);
  return result.data;
}

export { z };
