import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listTickets } from "~/domains/tickets/tickets.queries.server";
import { TicketStatus } from "~/generated/prisma/enums";
import { parseEnumParam } from "~/lib/validation.server";
import { StatusBadge } from "~/components/ui/status-badge";
import { berlinDateInput } from "~/lib/format-date";
import { ticketStatusLabel } from "~/components/tickets/labels";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile ticket list (track T-MOBILE). Thumb-friendly single column reflow of the
 * desktop list — same listTickets query (read-only, no domain fork). A field tech
 * browses, filters by status, and taps through to close a ticket at /m/tickets/:id.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "tickets.meta.list") }];
}

// Filter chips — the browse-relevant statuses (open / in progress / resolved).
const STATUS_CHIPS: TicketStatus[] = [
  TicketStatus.OPEN,
  TicketStatus.IN_PROGRESS,
  TicketStatus.RESOLVED,
];

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  // Validate against the enum like the desktop list — garbage is ignored.
  const status = parseEnumParam(TicketStatus, url.searchParams.get("status"));
  const q = url.searchParams.get("q")?.trim() || undefined;
  const tickets = await listTickets({ status, q });
  return { tickets, status: status ?? "" };
}

export default function MobileTicketsIndex({ loaderData }: Route.ComponentProps) {
  const { tickets, status } = loaderData;
  const t = useT();
  const locale = useLocale();
  return (
    <div className="flex flex-col">
      <div className="border-border border-b px-4 py-3">
        <h1 className="font-mono text-lg">{t("nav.tickets")}</h1>
      </div>

      {/* Status filter chips (tap targets >= 44px via min-h). */}
      <div className="border-border flex flex-wrap gap-2 border-b px-4 py-3">
        <FilterChip to="/m/tickets" active={status === ""} label={t("common.all")} />
        {STATUS_CHIPS.map((value) => (
          <FilterChip
            key={value}
            to={`/m/tickets?status=${value}`}
            active={status === value}
            label={ticketStatusLabel(locale, value)}
          />
        ))}
      </div>

      <ul className="divide-border divide-y">
        {tickets.map((ticket) => (
          <li key={ticket.id}>
            <Link
              to={`/m/tickets/${ticket.id}`}
              className="active:bg-accent flex min-h-11 items-center gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <StatusBadge kind="ticket" value={ticket.status} />
                  <p className="truncate text-base">{ticket.title}</p>
                </div>
                <p className="text-muted-foreground font-mono text-xs">
                  {[ticket.roomName ?? "—", berlinDateInput(ticket.occurredAt)].join(" · ")}
                </p>
              </div>
            </Link>
          </li>
        ))}
        {tickets.length === 0 ? (
          <li className="text-muted-foreground p-4 text-sm">{t("mobile.tickets.empty")}</li>
        ) : null}
      </ul>
    </div>
  );
}

function FilterChip({ to, active, label }: { to: string; active: boolean; label: string }) {
  return (
    <Link
      to={to}
      className={
        active
          ? "bg-primary text-primary-foreground flex min-h-11 items-center rounded-sm px-3 text-sm"
          : "border-border text-muted-foreground flex min-h-11 items-center rounded-sm border px-3 text-sm"
      }
    >
      {label}
    </Link>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
