import { FALLBACK_LOCALE, LOCALE_COOKIE, isLocale, matchLocale, type Locale } from "./locales";

const ONE_YEAR = 60 * 60 * 24 * 365;
const SECURE = process.env.NODE_ENV === "production" ? "; Secure" : "";

/** Installation-wide default: `DEFAULT_LOCALE`, else English. */
export function workspaceLocale(): Locale {
  return matchLocale(process.env.DEFAULT_LOCALE) ?? FALLBACK_LOCALE;
}

export function parseLocaleCookie(cookie: string | null | undefined): Locale | null {
  const match = (cookie ?? "").match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`));
  const value = match?.[1]?.trim();
  return isLocale(value) ? value : null;
}

/**
 * Best supported language of an `Accept-Language` header: highest q-value wins,
 * ties keep header order, `q=0` and unsupported languages are skipped.
 */
export function parseAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const candidates = header.split(",").flatMap((part, index) => {
    const [tag, ...params] = part.trim().split(";");
    const locale = matchLocale(tag);
    if (!locale) return [];
    const qParam = params.map((p) => p.trim()).find((p) => /^q=/i.test(p));
    const q = qParam === undefined ? 1 : Number.parseFloat(qParam.slice(2));
    if (!Number.isFinite(q) || q <= 0) return [];
    return [{ locale, q, index }];
  });
  candidates.sort((a, b) => b.q - a.q || a.index - b.index);
  return candidates[0]?.locale ?? null;
}

export function getLocaleCookie(request: Request): Locale | null {
  return parseLocaleCookie(request.headers.get("cookie"));
}

/** cookie `locale` → Accept-Language → `DEFAULT_LOCALE` → English. */
export function resolveLocaleFromHeaders(
  cookie: string | null | undefined,
  acceptLanguage: string | null | undefined,
): Locale {
  return parseLocaleCookie(cookie) ?? parseAcceptLanguage(acceptLanguage) ?? workspaceLocale();
}

export function resolveLocale(request: Request): Locale {
  return resolveLocaleFromHeaders(
    request.headers.get("cookie"),
    request.headers.get("accept-language"),
  );
}

export function setLocaleCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${SECURE}`;
}
