import { FALLBACK_LOCALE, isLocale, type Locale } from "./locales";

/**
 * The request locale inside a route's `meta()` export, which has no hooks:
 * read it from the root route's loader data in `matches`.
 */
export function metaLocale(
  matches: ReadonlyArray<{ id: string; loaderData?: unknown; data?: unknown } | undefined>,
): Locale {
  const root = matches.find((m) => m?.id === "root");
  const data = (root?.loaderData ?? root?.data) as { locale?: unknown } | undefined;
  return isLocale(data?.locale) ? data.locale : FALLBACK_LOCALE;
}
