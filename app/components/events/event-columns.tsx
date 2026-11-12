import { Link } from "react-router";
import { DateCell, StatusCell, type ColumnDef } from "~/components/data-grid";
import type { EventListRow } from "~/domains/events/events.queries.server";
import type { Translate } from "~/i18n";

const dash = <span className="text-muted-foreground">—</span>;

export function eventColumns(t: Translate): ColumnDef<EventListRow>[] {
  return [
    {
      accessorKey: "title",
      header: t("events.col.title"),
      size: 300,
      cell: ({ row }) => (
        <Link to={`/events/${row.original.id}`} className="truncate hover:underline">
          {row.original.title}
        </Link>
      ),
    },
    {
      accessorKey: "startsAt",
      header: t("events.col.startsAt"),
      size: 170,
      cell: ({ row }) => <DateCell value={row.original.startsAt} />,
    },
    {
      accessorKey: "endsAt",
      header: t("events.col.endsAt"),
      size: 170,
      cell: ({ row }) => <DateCell value={row.original.endsAt} />,
    },
    {
      accessorKey: "status",
      meta: { searchText: (row) => t(`status.event.${row.status}`) },
      header: t("events.col.status"),
      size: 140,
      cell: ({ row }) => <StatusCell kind="event" value={row.original.status} />,
    },
    {
      accessorKey: "roomCount",
      header: t("events.col.rooms"),
      size: 90,
      cell: ({ row }) => <span className="nums text-sm">{row.original.roomCount}</span>,
    },
    {
      accessorKey: "organizer",
      header: t("events.col.organizer"),
      size: 180,
      cell: ({ row }) =>
        row.original.organizer ? <span className="text-sm">{row.original.organizer}</span> : dash,
    },
  ];
}
