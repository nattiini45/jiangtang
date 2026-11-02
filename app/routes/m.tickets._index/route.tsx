import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listTickets } from "~/domains/tickets/tickets.queries.server";
import { TicketStatus } from "~/generated/prisma/enums";
import { parseEnumParam } from "~/lib/validation.server";
import { StatusBadge } from "~/components/ui/status-badge";
import { berlinDateInput } from "~/lib/format-date";
import { ticketStatusLabel } from "~/components/tickets/labels";
import { cn } from "~/lib/utils";
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

// Filter segments — the browse-relevant statuses (open / in progress / resolved).
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
    <div className="flex flex-col gap-4 px-4 py-4">
      <h1 className="text-lg font-semibold">{t("nav.tickets")}</h1>

      {/* Status filter as a segmented control (each segment is a 44px tap target). */}
      <div className="bg-tint flex rounded-full p-0.5">
        <SegmentLink to="/m/tickets" active={status === ""} label={t("common.all")} />
        {STATUS_CHIPS.map((value) => (
          <SegmentLink
            key={value}
            to={`/m/tickets?status=${value}`}
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
                <div className="flex items-center gap-2">
                  <StatusBadge kind="ticket" value={ticket.status} />
                  <p className="min-w-0 truncate text-sm font-semibold">{ticket.title}</p>
                </div>
                <p className="text-muted-foreground nums text-xs">
                  {[ticket.roomName ?? "—", berlinDateInput(ticket.occurredAt)].join(" · ")}
                </p>
              </div>
            </Link>
          </li>
        ))}
        {tickets.length === 0 ? (
          <li className="text-muted-foreground px-3 py-4 text-sm">{t("mobile.tickets.empty")}</li>
        ) : null}
      </ul>
    </div>
  );
}

/** One option of a segmented filter: the selected segment is a raised card. */
function SegmentLink({ to, active, label }: { to: string; active: boolean; label: string }) {
  return (
    <Link
      to={to}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex min-h-11 flex-1 items-center justify-center rounded-full px-2 text-center text-sm leading-tight transition-colors duration-80",
        active ? "bg-card shadow-surface-1 font-semibold" : "text-muted-foreground",
      )}
    >
      {label}
    </Link>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
