import { CalendarDays } from "lucide-react";
import { berlinDateKey } from "~/lib/berlin-days";
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
      size: 220,
      cell: ({ row }) => (
        <Link to={`/events/${row.original.id}`} className="truncate hover:underline">
          {row.original.title}
        </Link>
      ),
    },
    {
      accessorKey: "startsAt",
      header: t("events.col.startsAt"),
      size: 140,
      cell: ({ row }) => <DateCell value={row.original.startsAt} />,
    },
    {
      accessorKey: "endsAt",
      header: t("events.col.endsAt"),
      size: 140,
      cell: ({ row }) => <DateCell value={row.original.endsAt} />,
    },
    {
      accessorKey: "status",
      meta: { searchText: (row) => t(`status.event.${row.status}`) },
      header: t("events.col.status"),
      size: 120,
      cell: ({ row }) => <StatusCell kind="event" value={row.original.status} />,
    },
    {
      accessorKey: "roomNames",
      header: t("events.col.rooms"),
      size: 160,
      cell: ({ row }) => (
        <span className="truncate text-sm" title={row.original.roomNames.join(" · ")}>
          {row.original.roomNames.join(" · ") || dash}
        </span>
      ),
    },
    {
      id: "calendar",
      header: t("nav.calendar"),
      size: 76,
      enableSorting: false,
      cell: ({ row }) => (
        <Link
          to={`/calendar?view=day&date=${berlinDateKey(row.original.startsAt)}`}
          aria-label={t("calendar.openDay")}
          className="hover:bg-hover inline-flex rounded-md p-2"
        >
          <CalendarDays className="size-icon" aria-hidden />
        </Link>
      ),
    },
  ];
}
