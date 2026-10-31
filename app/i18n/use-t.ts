import { useMemo } from "react";
import { useRouteLoaderData } from "react-router";
import { t, type Translate } from "./index";
import { FALLBACK_LOCALE, isLocale, type Locale } from "./locales";

/** The request locale the root loader resolved (cookie → Accept-Language → workspace default). */
export function useLocale(): Locale {
  const data = useRouteLoaderData("root") as { locale?: unknown } | undefined;
  return isLocale(data?.locale) ? data.locale : FALLBACK_LOCALE;
}

export function useT(): Translate {
  const locale = useLocale();
  return useMemo<Translate>(() => (key, params) => t(locale, key, params), [locale]);
}
