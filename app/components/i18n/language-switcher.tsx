import { useFetcher, useLocation } from "react-router";
import { cn } from "~/lib/utils";
import { LOCALES, isLocale, type Locale } from "~/i18n/locales";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * DE/EN segmented control. A plain `<form method="post">` to `/prefs/locale`,
 * so it works before hydration; with JS the fetcher's redirect revalidates the
 * current route and it re-renders in the chosen language. The option names stay
 * in their own language ("Deutsch", "English") whatever the UI language is. Each
 * button's accessible name starts with its visible code ("de Deutsch"), so a
 * speech-input user can say what they see (WCAG 2.5.3, Label in Name).
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
      className={cn("bg-tint inline-flex gap-0.5 rounded-md p-0.5", className)}
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
            title={t(`shell.language.${locale}`)}
            className={cn(
              "cursor-pointer rounded-sm text-xs transition-[color,background-color,box-shadow] duration-80 focus-visible:z-10",
              size === "lg" ? "min-h-11 min-w-11 px-3" : "h-7 min-w-8 px-2",
              shown === locale
                ? "bg-card text-foreground shadow-surface-1 font-semibold"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {locale.toUpperCase()} <span className="sr-only">{t(`shell.language.${locale}`)}</span>
          </button>
        ))}
    </fetcher.Form>
  );
}
