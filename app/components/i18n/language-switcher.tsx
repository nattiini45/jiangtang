import { useFetcher, useLocation } from "react-router";
import { cn } from "~/lib/utils";
import { LOCALES, isLocale, type Locale } from "~/i18n/locales";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * DE/EN segmented control. A plain `<form method="post">` to `/prefs/locale`,
 * so it works before hydration; with JS the fetcher's redirect revalidates the
 * current route and it re-renders in the chosen language. The option names stay
 * in their own language ("Deutsch", "English") whatever the UI language is.
 */
export function LanguageSwitcher({
  size = "sm",
  className,
}: {
  size?: "sm" | "lg";
  className?: string;
}) {
  const t = useT();
  const active = useLocale();
  const fetcher = useFetcher();
  const location = useLocation();
  const submitted = fetcher.formData?.get("locale");
  const shown: Locale = isLocale(submitted) ? submitted : active;

  return (
    <fetcher.Form
      method="post"
      action="/prefs/locale"
      role="group"
      aria-label={t("shell.language.label")}
      className={cn("border-border inline-flex overflow-hidden rounded-sm border", className)}
    >
      <input type="hidden" name="next" value={`${location.pathname}${location.search}`} />
      {LOCALES.slice()
        .sort()
        .map((locale) => (
          <button
            key={locale}
            type="submit"
            name="locale"
            value={locale}
            lang={locale}
            aria-pressed={shown === locale}
            aria-label={t(`shell.language.${locale}`)}
            title={t(`shell.language.${locale}`)}
            className={cn(
              "focus-visible:ring-ring font-mono text-xs uppercase focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2",
              size === "lg" ? "min-h-11 min-w-11 px-3" : "h-7 min-w-8 px-2",
              shown === locale
                ? "bg-secondary text-secondary-foreground font-semibold"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {locale}
          </button>
        ))}
    </fetcher.Form>
  );
}
