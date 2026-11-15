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
      cell: ({ row }) => (
        <Link to={`/events/${row.original.id}`} className="truncate hover:underline">
          {row.original.title}
        </Link>
      ),
    },
    {
      accessorKey: "startsAt",
      meta: { sizing: "short" },
      header: t("events.col.startsAt"),
      cell: ({ row }) => <DateCell value={row.original.startsAt} />,
    },
    {
      accessorKey: "endsAt",
      meta: { sizing: "short" },
      header: t("events.col.endsAt"),
      cell: ({ row }) => <DateCell value={row.original.endsAt} />,
    },
    {
      accessorKey: "status",
      meta: { sizing: "short", searchText: (row) => t(`status.event.${row.status}`) },
      header: t("events.col.status"),
      cell: ({ row }) => <StatusCell kind="event" value={row.original.status} />,
    },
    {
      accessorKey: "roomNames",
      header: t("events.col.rooms"),
      cell: ({ row }) => (
        <span className="truncate text-sm" title={row.original.roomNames.join(" · ")}>
          {row.original.roomNames.join(" · ") || dash}
        </span>
      ),
    },
    {
      id: "calendar",
      meta: { sizing: "short" },
      header: t("nav.calendar"),
      enableSorting: false,
      cell: ({ row }) => (
        <Link
          to={`/calendar?view=day&date=${berlinDateKey(row.original.startsAt)}`}
          aria-label={t("calendar.openDay")}
          className="hover:bg-hover inline-flex h-control w-8 items-center justify-center rounded-md"
        >
          <CalendarDays className="size-icon" aria-hidden />
        </Link>
      ),
    },
  ];
}
