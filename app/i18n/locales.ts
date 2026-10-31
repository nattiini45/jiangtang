export const LOCALES = ["en", "de"] as const;
export type Locale = (typeof LOCALES)[number];

/** Last resort when neither the visitor nor the installation expresses a preference. */
export const FALLBACK_LOCALE: Locale = "en";

export const LOCALE_COOKIE = "locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** BCP-47 tag handed to `Intl`. English is en-GB: 24-hour clock and day-first dates, matching Berlin wall-clock use. */
export function localeTag(locale: Locale): "en-GB" | "de-DE" {
  return locale === "de" ? "de-DE" : "en-GB";
}

/**
 * Map a language tag ("de", "de-AT", "EN-us") to a supported locale by its
 * primary subtag; null when the language is not supported.
 */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : null;
}
