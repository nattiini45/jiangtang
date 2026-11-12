import { Link } from "react-router";
import { DateCell, StatusCell, type ColumnDef } from "~/components/data-grid";
import type { RoomListRow } from "~/domains/rooms/rooms.queries.server";
import type { Translate } from "~/i18n";

const dash = <span className="text-muted-foreground">—</span>;

export function roomColumns(t: Translate): ColumnDef<RoomListRow>[] {
  return [
    {
      accessorKey: "roomNumber",
      header: t("rooms.col.roomNumber"),
      size: 98,
      cell: ({ row }) =>
        row.original.roomNumber ? <span className="nums">{row.original.roomNumber}</span> : dash,
    },
    {
      accessorKey: "name",
      header: t("rooms.col.name"),
      size: 142,
      cell: ({ row }) => (
        <Link
          to={`/rooms/${row.original.slug}`}
          className="truncate hover:underline"
          title={row.original.name}
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: "campusName",
      header: t("rooms.col.campus"),
      size: 90,
      cell: ({ row }) => (
        <span className="truncate text-sm" title={row.original.campusName ?? undefined}>
          {row.original.campusName ?? "—"}
        </span>
      ),
    },
    {
      accessorKey: "status",
      meta: { searchText: (row) => t(`status.room.${row.status}`) },
      header: t("rooms.col.status"),
      size: 174,
      cell: ({ row }) => <StatusCell kind="room" value={row.original.status} />,
    },
    {
      accessorKey: "capacity",
      header: t("rooms.col.capacity"),
      size: 74,
      cell: ({ row }) =>
        row.original.capacity != null ? (
          <span className="nums">{row.original.capacity}</span>
        ) : (
          dash
        ),
    },
    {
      accessorKey: "equipmentCount",
      header: t("rooms.col.equipment"),
      size: 80,
      cell: ({ row }) => <span className="nums">{row.original.equipmentCount}</span>,
    },
    {
      accessorFn: (row) => row.knownIssues ?? "",
      id: "knownIssues",
      header: t("rooms.knownIssues"),
      size: 176,
      cell: ({ row }) =>
        row.original.knownIssues ? (
          <span className="truncate" title={row.original.knownIssues}>
            {row.original.knownIssues}
          </span>
        ) : (
          dash
        ),
    },
    {
      accessorFn: (row) => row.lastCheckedAt?.getTime(),
      id: "lastCheckedAt",
      header: t("rooms.lastChecked"),
      size: 146,
      sortUndefined: "last",
      sortingFn: "basic",
      cell: ({ row }) => <DateCell value={row.original.lastCheckedAt} withTime={false} />,
    },
  ];
}
