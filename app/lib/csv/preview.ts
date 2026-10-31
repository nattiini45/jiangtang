import { z } from "zod";
import { localizeMessage } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import { currentLocale } from "~/i18n/request-locale.server";
import { parseCsvToObjects } from "./parse";

/**
 * Validate parsed CSV rows against a zod schema, splitting into valid (typed) and
 * invalid (with per-row messages). Pure — used by the import preview step before
 * anything is written. `line` is 1-based including the header row.
 */

export interface CsvPreview<T> {
  headers: string[];
  valid: { line: number; data: T }[];
  invalid: { line: number; raw: Record<string, string>; messages: string[] }[];
}

export function previewCsv<S extends z.ZodTypeAny>(
  csv: string,
  schema: S,
  locale: Locale = currentLocale(),
): CsvPreview<z.infer<S>> {
  const { headers, rows } = parseCsvToObjects(csv);
  const valid: { line: number; data: z.infer<S> }[] = [];
  const invalid: { line: number; raw: Record<string, string>; messages: string[] }[] = [];

  rows.forEach((raw, i) => {
    const line = i + 2; // header is line 1
    const res = schema.safeParse(raw);
    if (res.success) {
      valid.push({ line, data: res.data });
    } else {
      const flat = res.error.flatten();
      const messages = [
        ...flat.formErrors.map((m) => localizeMessage(locale, m)),
        ...Object.entries(flat.fieldErrors).flatMap(([k, v]) =>
          (v ?? []).map((m) => `${k}: ${localizeMessage(locale, m)}`),
        ),
      ];
      invalid.push({ line, raw, messages });
    }
  });

  return { headers, valid, invalid };
}
