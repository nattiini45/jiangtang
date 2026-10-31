import { Link } from "react-router";
import { cn } from "~/lib/utils";
import { useT } from "~/i18n/use-t";

/**
 * Preset date-range picker for the analytics dashboard (track T-Analytics).
 * Renders link-chips that set `?days=N` on the current route — presets only
 * (operational simplicity, no free-form date inputs). The active preset is
 * marked so the URL-only window is visible in the UI.
 */
const PRESETS = [30, 90, 180, 365] as const;

export function RangePicker({ days }: { days: number }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">{t("analytics.range.label")}</span>
      <div className="border-border flex border">
        {PRESETS.map((preset) => {
          const active = preset === days;
          return (
            <Link
              key={preset}
              to={`?days=${preset}`}
              aria-current={active ? "true" : undefined}
              className={cn(
                "border-border font-mono text-xs px-3 py-1.5 not-first:border-l transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t("analytics.range.days", { days: preset })}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
