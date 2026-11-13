import { Link } from "react-router";
import type { RoomFunctionState } from "~/domains/functions/functions.queries.server";
import { useLocale, useT } from "~/i18n/use-t";
import { formatDate, formatDateTime } from "~/i18n/format";
import { Badge } from "~/components/ui/badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { ViewSwitch } from "~/components/layout/view-switch";
import { StatusBadge } from "~/components/ui/status-badge";
import { toneClassName, toneDotClassName } from "~/lib/status";

export function RoomFunctions({
  functions,
  roomId,
  roomStatus,
  mobile = false,
}: {
  functions: RoomFunctionState[];
  roomId: string;
  roomStatus: string;
  mobile?: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <section className="min-w-0" aria-labelledby="room-functions-title">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 id="room-functions-title" className="text-base font-semibold">
          {t("functions.title")}
        </h2>
        {mobile ? (
          <Button asChild variant="secondary" className="min-h-11">
            <Link to={`/m/tickets/new?roomId=${roomId}`}>{t("functions.report")}</Link>
          </Button>
        ) : (
          <ViewSwitch
            view="mobile"
            next={`/m/tickets/new?roomId=${roomId}`}
            className={buttonVariants({ variant: "secondary" })}
          >
            {t("functions.report")}
          </ViewSwitch>
        )}
      </div>
      {roomStatus === "ALL_GOOD" && functions.some((row) => row.state === "DOWN") ? (
        <p className="mb-3 text-sm text-muted-foreground">{t("functions.roomHint")}</p>
      ) : null}
      {!functions.length ? (
        <p className="text-sm text-muted-foreground">{t("functions.empty")}</p>
      ) : (
        <ul className="bg-card shadow-surface-2 divide-y rounded-lg">
          {functions.map((row) => {
            const tone =
              row.state === "DOWN" ? "fault" : row.state === "LIMITED" ? "warning" : "neutral";
            return (
              <li
                key={row.functionId}
                id={`function-${row.functionId}`}
                className="flex min-w-0 flex-col gap-2 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-sm font-semibold" title={row.name}>
                    {row.name}
                  </h3>
                  <Badge className={toneClassName(tone)}>
                    <span
                      aria-hidden
                      className={`size-1.5 rounded-full ${toneDotClassName(tone)}`}
                    />
                    {t(`functions.state.${row.state}`)}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {row.causes.length
                    ? row.since
                      ? t("functions.since", { date: formatDateTime(locale, row.since) })
                      : t("functions.before", { date: formatDate(locale, "2026-11-13T00:00:00Z") })
                    : t("functions.never")}
                </p>
                {row.causes.map((cause, index) => {
                  const fault = row.faults.find((fault) => fault.id === cause.ticketId);
                  const device = row.devices.find((device) => device.id === cause.deviceId);
                  return (
                    <p
                      key={index}
                      className="truncate text-sm"
                      title={fault?.title ?? device?.name}
                    >
                      {fault ? (
                        <Link
                          className="underline underline-offset-4"
                          to={`${mobile ? "/m" : ""}/tickets/${fault.id}`}
                        >
                          {fault.title}
                        </Link>
                      ) : (
                        device?.name
                      )}
                    </p>
                  );
                })}
                <div className="flex min-w-0 flex-wrap gap-2">
                  {row.devices.map((device) => (
                    <span key={device.id} className="flex max-w-full items-center gap-1.5 text-xs">
                      <span className="min-w-0 truncate" title={device.name}>
                        {device.name}
                      </span>
                      <StatusBadge kind="equipment" value={device.status} />
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
