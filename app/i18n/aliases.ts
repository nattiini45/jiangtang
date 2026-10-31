import { messages, type MessageKey } from "./index";
import { LOCALES } from "./locales";

/**
 * Lower-cased lookup for a CSV cell naming an enum value: the enum value itself
 * or its label in ANY supported language, independent of the UI language the
 * importer happens to be using. Returns null for a cell that names nothing.
 */
export function enumAliasMap<E extends string>(
  values: readonly E[],
  keyOf: (value: E) => MessageKey,
): { resolve(cell: string): E | null; labels(locale: (typeof LOCALES)[number]): string[] } {
  const byText = new Map<string, E>();
  for (const value of values) {
    byText.set(value.toLowerCase(), value);
    for (const locale of LOCALES) {
      byText.set(messages(locale)[keyOf(value)].toLowerCase(), value);
    }
  }
  return {
    resolve: (cell) => byText.get(cell.trim().toLowerCase()) ?? null,
    labels: (locale) => values.map((v) => messages(locale)[keyOf(v)]),
  };
}
