import { Link } from "react-router";
import { DateCell, StatusCell, type ColumnDef } from "~/components/data-grid";
import type { TicketListRow } from "~/domains/tickets/tickets.queries.server";
import type { Translate } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import { priorityLabel, ticketTypeLabel } from "./labels";

const dash = <span className="text-muted-foreground">—</span>;

export function ticketColumns(t: Translate, locale: Locale): ColumnDef<TicketListRow>[] {
  return [
    {
      accessorKey: "type",
      meta: { searchText: (row) => ticketTypeLabel(locale, row.type) },
      header: t("tickets.col.type"),
      size: 110,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-xs">
          {ticketTypeLabel(locale, row.original.type)}
        </span>
      ),
    },
    {
      accessorKey: "title",
      header: t("tickets.col.title"),
      size: 320,
      cell: ({ row }) => (
        <Link to={`/tickets/${row.original.id}`} className="truncate hover:underline">
          {row.original.title}
        </Link>
      ),
    },
    {
      accessorKey: "roomName",
      header: t("tickets.col.room"),
      size: 180,
      cell: ({ row }) =>
        row.original.roomSlug ? (
          <Link to={`/rooms/${row.original.roomSlug}`} className="text-sm hover:underline">
            {row.original.roomName}
          </Link>
        ) : (
          dash
        ),
    },
    {
      accessorKey: "status",
      meta: { searchText: (row) => t(`status.ticket.${row.status}`) },
      header: t("tickets.col.status"),
      size: 130,
      cell: ({ row }) => <StatusCell kind="ticket" value={row.original.status} />,
    },
    {
      accessorKey: "priority",
      meta: {
        searchText: (row) => (row.priority != null ? priorityLabel(locale, row.priority) : null),
      },
      header: t("tickets.col.priority"),
      size: 90,
      cell: ({ row }) =>
        row.original.priority != null ? (
          <span className="text-sm">{priorityLabel(locale, row.original.priority)}</span>
        ) : (
          dash
        ),
    },
    {
      id: "assignees",
      header: t("tickets.col.assignees"),
      size: 130,
      accessorFn: (r) => r.assignees.join(" "),
      cell: ({ row }) =>
        row.original.assignees.length ? (
          <span className="text-sm">{row.original.assignees.join(", ")}</span>
        ) : (
          dash
        ),
    },
    {
      accessorKey: "occurredAt",
      header: t("tickets.col.occurredAt"),
      size: 150,
      cell: ({ row }) => <DateCell value={row.original.occurredAt} withTime={false} />,
    },
  ];
}
