import * as React from "react";
import { Form, Link, redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listEventsForPlanning } from "~/domains/events/events.queries.server";
import { EventStatus } from "~/generated/prisma/enums";
import { parseEnumParam } from "~/lib/validation.server";
import { legacyCalendarHref } from "~/lib/calendar-entries";
import { DataGrid } from "~/components/data-grid";
import { eventColumns } from "~/components/events/event-columns";
import { eventStatusLabel } from "~/components/events/labels";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "events.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const params = new URL(request.url).searchParams;
  const legacy = legacyCalendarHref(params);
  if (legacy) throw redirect(legacy);
  const status = parseEnumParam(EventStatus, params.get("status"));
  return { events: await listEventsForPlanning(status), status: status ?? "" };
}

export default function EventsIndex({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const columns = React.useMemo(() => eventColumns(t), [t]);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t("events.list.title")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t("events.list.subtitle")}</p>
        </div>
        <Button asChild>
          <Link to="/events/new">{t("events.list.new")}</Link>
        </Button>
      </header>
      <Form
        key={loaderData.status}
        method="get"
        className="flex items-center gap-2"
        onChange={(event) => event.currentTarget.requestSubmit()}
      >
        <Select
          name="status"
          aria-label={t("events.list.filterStatus")}
          defaultValue={loaderData.status}
          className="w-48"
        >
          <option value="">{t("events.list.allStatuses")}</option>
          {Object.values(EventStatus).map((status) => (
            <option key={status} value={status}>
              {eventStatusLabel(locale, status)}
            </option>
          ))}
        </Select>
        <noscript>
          <Button type="submit" variant="tertiary">
            {t("events.list.filterSubmit")}
          </Button>
        </noscript>
      </Form>
      <DataGrid
        columns={columns}
        data={loaderData.events}
        getRowId={(event) => event.id}
        growColumn="title"
        emptyMessage={t("events.list.empty")}
        maxHeight={720}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
