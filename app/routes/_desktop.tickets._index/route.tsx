import * as React from "react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { listTickets } from "~/domains/tickets/tickets.queries.server";
import { TicketStatus, TicketType } from "~/generated/prisma/enums";
import { parseEnumParam } from "~/lib/validation.server";
import { DataGrid } from "~/components/data-grid";
import { ticketColumns } from "~/components/tickets/ticket-columns";
import { ticketStatusLabel, ticketTypeLabel } from "~/components/tickets/labels";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "tickets.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const type = parseEnumParam(TicketType, url.searchParams.get("type"));
  const status = parseEnumParam(TicketStatus, url.searchParams.get("status"));

  const tickets = await listTickets({ type, status });
  return { tickets, filters: { type: type ?? "", status: status ?? "" } };
}

export default function TicketsList({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const columns = React.useMemo(() => ticketColumns(t, locale), [t, locale]);
  const { tickets, filters } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) =>
    e.currentTarget.form?.requestSubmit();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("tickets.list.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("tickets.list.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="tertiary">
            <Link to="/quick-entry">{t("tickets.list.quickEntry")}</Link>
          </Button>
          <Button asChild>
            <Link to="/tickets/new">{t("tickets.list.new")}</Link>
          </Button>
        </div>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <Select
          name="type"
          aria-label={t("tickets.list.filterType")}
          defaultValue={filters.type}
          className="max-w-[14rem]"
          onChange={autoSubmit}
        >
          <option value="">{t("tickets.list.allTypes")}</option>
          {Object.values(TicketType).map((type) => (
            <option key={type} value={type}>
              {ticketTypeLabel(locale, type)}
            </option>
          ))}
        </Select>
        <Select
          name="status"
          aria-label={t("tickets.list.filterStatus")}
          defaultValue={filters.status}
          className="max-w-[14rem]"
          onChange={autoSubmit}
        >
          <option value="">{t("tickets.list.allStatuses")}</option>
          {Object.values(TicketStatus).map((s) => (
            <option key={s} value={s}>
              {ticketStatusLabel(locale, s)}
            </option>
          ))}
        </Select>
        <noscript>
          <Button type="submit" variant="tertiary" size="compact">
            {t("tickets.list.filterSubmit")}
          </Button>
        </noscript>
      </Form>

      <DataGrid
        columns={columns}
        data={tickets}
        getRowId={(ticket) => ticket.id}
        emptyMessage={t("tickets.list.empty")}
        maxHeight={640}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
