import { Card, CardHeader, CardTitle } from "~/components/ui/card";
import { syncStatusLabel } from "~/components/events/labels";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDateTime } from "~/i18n/format";
import { cn } from "~/lib/utils";
import { toneDotClassName, type StatusTone } from "~/lib/status";

const SYNC_TONE: Record<string, StatusTone> = {
  SENT: "operational",
  FAILED: "fault",
  PENDING: "warning",
};

export function CalendarSyncPanel({
  sync,
}: {
  sync: {
    configured: boolean;
    latest: {
      status: string;
      attempts: number;
      lastError: string | null;
      processedAt: Date | string | null;
    } | null;
  };
}) {
  const locale = useLocale();
  const t = useT();
  const latest = sync.configured ? sync.latest : null;
  if (sync.configured && !latest) return null;
  const status = sync.configured ? latest!.status : "NOTCONFIGURED";
  const processed = latest?.processedAt ? formatDateTime(locale, latest.processedAt) : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("events.sync.title")}</CardTitle>
      </CardHeader>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-4 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              toneDotClassName(SYNC_TONE[status] ?? "neutral"),
            )}
          />
          {syncStatusLabel(locale, status)}
        </span>
        {processed ? <span className="text-muted-foreground nums text-xs">{processed}</span> : null}
        {latest && latest.attempts > 0 ? (
          <span className="text-muted-foreground nums text-xs">
            {t("events.sync.attempts", { attempts: latest.attempts })}
          </span>
        ) : null}
        {latest?.status !== "SENT" && latest?.lastError ? (
          <span className="text-destructive w-full truncate text-xs" title={latest.lastError}>
            {latest.lastError.slice(0, 200)}
          </span>
        ) : null}
      </div>
    </Card>
  );
}
