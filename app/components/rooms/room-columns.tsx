import { Link } from "react-router";
import { DateCell, StatusCell, type ColumnDef } from "~/components/data-grid";
import type { RoomListRow } from "~/domains/rooms/rooms.queries.server";
import type { Translate } from "~/i18n";

const dash = <span className="text-muted-foreground">—</span>;

export function roomColumns<T extends RoomListRow = RoomListRow>(t: Translate): ColumnDef<T>[] {
  return [
    {
      accessorKey: "roomNumber",
      meta: { sizing: "short" },
      header: t("rooms.col.roomNumber"),
      cell: ({ row }) =>
        row.original.roomNumber ? <span className="nums">{row.original.roomNumber}</span> : dash,
    },
    {
      accessorKey: "name",
      header: t("rooms.col.name"),
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
      cell: ({ row }) => (
        <span className="truncate text-sm" title={row.original.campusName ?? undefined}>
          {row.original.campusName ?? "—"}
        </span>
      ),
    },
    {
      accessorKey: "status",
      meta: { sizing: "short", searchText: (row) => t(`status.room.${row.status}`) },
      header: t("rooms.col.status"),
      cell: ({ row }) => <StatusCell kind="room" value={row.original.status} />,
    },
    {
      accessorKey: "capacity",
      meta: { sizing: "short" },
      header: t("rooms.col.capacity"),
      cell: ({ row }) =>
        row.original.capacity != null ? (
          <span className="nums">{row.original.capacity}</span>
        ) : (
          dash
        ),
    },
    {
      accessorKey: "equipmentCount",
      meta: { sizing: "short" },
      header: t("rooms.col.equipment"),
      cell: ({ row }) => <span className="nums">{row.original.equipmentCount}</span>,
    },
    {
      accessorFn: (row) => row.knownIssues ?? "",
      id: "knownIssues",
      header: t("rooms.knownIssues"),
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
      meta: { sizing: "short" },
      enableGlobalFilter: false,
      header: t("rooms.lastChecked"),
      sortUndefined: "last",
      sortingFn: "basic",
      cell: ({ row }) => <DateCell value={row.original.lastCheckedAt} withTime={false} />,
    },
  ];
}
