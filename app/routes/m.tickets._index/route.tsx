import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listTickets } from "~/domains/tickets/tickets.queries.server";
import { TicketStatus } from "~/generated/prisma/enums";
import { parseEnumParam } from "~/lib/validation.server";
import { StatusBadge } from "~/components/ui/status-badge";
import { formatDate } from "~/i18n/format";
import { EmptyState } from "~/components/states/empty-state";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { Ticket } from "lucide-react";
import { ticketStatusLabel } from "~/components/tickets/labels";
import { SegmentLink } from "~/components/ui/segment-link";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile ticket list. Thumb-friendly single column reflow of the
 * desktop list — same listTickets query (read-only, no domain fork). A field tech
 * browses, filters by status, and taps through to close a ticket at /m/tickets/:id.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "tickets.meta.list") }];
}

// Filter segments — the browse-relevant statuses (open / in progress / resolved).
const STATUS_CHIPS: TicketStatus[] = [
  TicketStatus.OPEN,
  TicketStatus.IN_PROGRESS,
  TicketStatus.RESOLVED,
];

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await requireUser(request);
  const url = new URL(request.url);
  // Validate against the enum like the desktop list — garbage is ignored.
  const status = parseEnumParam(TicketStatus, url.searchParams.get("status"));
  const q = url.searchParams.get("q")?.trim() || undefined;
  const mine = url.searchParams.get("assignee") === "me";
  const tickets = await listTickets({
    status,
    q,
    assigneeId: mine ? actor.id : undefined,
    openWorkForUser: mine && !status ? actor.id : undefined,
  });
  return { tickets, status: status ?? "", q: q ?? "", mine };
}

export default function MobileTicketsIndex({ loaderData }: Route.ComponentProps) {
  const { tickets, status, q, mine } = loaderData;
  const t = useT();
  const locale = useLocale();
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <h1 className="text-lg font-semibold">
        {t(mine ? "dashboard.home.mine.ticketsTitle" : "nav.tickets")}
      </h1>
      <Button asChild className="min-h-11">
        <Link to="/m/tickets/new">{t("functions.report")}</Link>
      </Button>
      <Form method="get" className="flex flex-col gap-2">
        {mine ? <input type="hidden" name="assignee" value="me" /> : null}
        <Label htmlFor="ticket-search">{t("mobile.tickets.search")}</Label>
        {status ? <input type="hidden" name="status" value={status} /> : null}
        <div className="flex gap-2">
          <Input
            key={q}
            id="ticket-search"
            type="search"
            name="q"
            defaultValue={q}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary">
            {t("nav.search")}
          </Button>
        </div>
      </Form>

      {/* Status filter as a segmented control (each segment is a 44px tap target). */}
      <div className="bg-tint grid grid-cols-2 rounded-xl p-0.5">
        <SegmentLink
          to={`/m/tickets?${new URLSearchParams({ q, ...(mine ? { assignee: "me" } : {}) })}`}
          active={status === ""}
          label={t(mine ? "dashboard.home.mine.openTickets" : "common.all")}
        />
        {STATUS_CHIPS.map((value) => (
          <SegmentLink
            key={value}
            to={`/m/tickets?${new URLSearchParams({ q, status: value, ...(mine ? { assignee: "me" } : {}) })}`}
            active={status === value}
            label={ticketStatusLabel(locale, value)}
          />
        ))}
      </div>

      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <Link
              to={`/m/tickets/${ticket.id}`}
              className="active:bg-selected flex min-h-12 items-center gap-3 px-3 py-2 transition-colors duration-80"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge kind="ticket" value={ticket.status} />
                  <p className="min-w-0 whitespace-normal text-sm font-semibold">{ticket.title}</p>
                </div>
                <p className="text-muted-foreground nums text-xs">
                  {[ticket.roomName ?? "—", formatDate(locale, ticket.occurredAt)].join(" · ")}
                </p>
              </div>
            </Link>
          </li>
        ))}
        {tickets.length === 0 ? (
          <li>
            <EmptyState
              icon={Ticket}
              title={t(q || status ? "mobile.filters.emptyTitle" : "mobile.tickets.empty")}
              hint={t(q || status ? "mobile.filters.emptyHint" : "mobile.tickets.emptyHint")}
              action={
                q || status
                  ? { to: "/m/tickets", label: t("mobile.filters.clear") }
                  : { to: "/m/quick-entry", label: t("mobile.entry.submit") }
              }
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
