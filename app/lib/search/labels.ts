import { t, type MessageKey } from "~/i18n";
import type { Locale } from "~/i18n/locales";

/**
 * Display labels for the search surface — client-safe: the /search page,
 * the command palette and the ask UI all render these.
 */

/** Index source type → badge label; an unknown type renders as itself. */
export function sourceTypeLabel(locale: Locale, sourceType: string): string {
  const key = `search.sourceType.${sourceType}` as MessageKey;
  const label = t(locale, key);
  return label === key ? sourceType : label;
}

/** Which recall arm hit — hint for the /search result meta line. */
export function armLabel(locale: Locale, arm: string): string {
  const key = `search.arm.${arm}` as MessageKey;
  const label = t(locale, key);
  return label === key ? arm : label;
}

/** `TASK·cmuw83nf#0` — the mono citation anchor on /search results. */
export function searchAnchor(sourceType: string, sourceId: string, ordinal: number): string {
  return `${sourceType}·${sourceId.slice(0, 8)}#${ordinal}`;
}
