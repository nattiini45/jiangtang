import * as React from "react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listEvents } from "~/domains/events/events.queries.server";
import { EventStatus } from "~/generated/prisma/enums";
import { parseEnumParam } from "~/lib/validation.server";
import { DataGrid } from "~/components/data-grid";
import { eventColumns } from "~/components/events/event-columns";
import { EventCalendar } from "~/components/events/event-calendar";
import { CalendarSubscribe } from "~/components/events/calendar-subscribe";
import { eventStatusLabel } from "~/components/events/labels";
import { Button, buttonVariants } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "events.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const user = await requireUser(request);
  const status = parseEnumParam(EventStatus, url.searchParams.get("status"));
  const view = url.searchParams.get("view") === "calendar" ? "calendar" : "list";
  const month = url.searchParams.get("month");
  const events = await listEvents({ status });
  // The iCal feed URL is only surfaced to admins (they hand it to the team
  // calendar). Built from the configured token; absent if unset.
  const feedToken = process.env.ICAL_FEED_TOKEN;
  const feedUrl =
    user.role === "ADMIN" && feedToken
      ? `${url.protocol}//${url.host}/calendar/${feedToken}/ics`
      : null;
  return { events, filters: { status: status ?? "" }, view, month, feedUrl };
}

export default function EventsList({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const columns = React.useMemo(() => eventColumns(t), [t]);
  const { events, filters, view, month, feedUrl } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) =>
    e.currentTarget.form?.requestSubmit();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("events.list.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("events.list.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {feedUrl ? <CalendarSubscribe url={feedUrl} /> : null}
          <Button asChild>
            <Link to="/events/new">{t("events.list.new")}</Link>
          </Button>
        </div>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        {/* Preserve the view/month when the status filter changes. */}
        {view === "calendar" ? <input type="hidden" name="view" value="calendar" /> : null}
        {view === "calendar" && month ? <input type="hidden" name="month" value={month} /> : null}
        <Select
          name="status"
          aria-label={t("events.list.filterStatus")}
          defaultValue={filters.status}
          className="max-w-[14rem]"
          onChange={autoSubmit}
        >
          <option value="">{t("events.list.allStatuses")}</option>
          {Object.values(EventStatus).map((s) => (
            <option key={s} value={s}>
              {eventStatusLabel(locale, s)}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-1">
          <Link
            to={`?${qs({ status: filters.status, view: "list" })}`}
            aria-current={view === "list" ? "page" : undefined}
            className={buttonVariants({
              variant: view === "list" ? "secondary" : "ghost",
              size: "compact",
            })}
          >
            {t("events.list.viewList")}
          </Link>
          <Link
            to={`?${qs({ status: filters.status, view: "calendar" })}`}
            aria-current={view === "calendar" ? "page" : undefined}
            className={buttonVariants({
              variant: view === "calendar" ? "secondary" : "ghost",
              size: "compact",
            })}
          >
            {t("events.list.viewCalendar")}
          </Link>
        </div>
        <noscript>
          <Button type="submit" variant="tertiary" size="compact">
            {t("events.list.filterSubmit")}
          </Button>
        </noscript>
      </Form>

      {view === "calendar" ? (
        <EventCalendar events={events} month={month} />
      ) : (
        <DataGrid
          columns={columns}
          data={events}
          getRowId={(e) => e.id}
          emptyMessage={t("events.list.empty")}
          maxHeight={640}
        />
      )}
    </div>
  );
}

function qs(parts: Record<string, string>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(parts)) {
    if (v) sp.set(k, v);
  }
  return sp.toString();
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
