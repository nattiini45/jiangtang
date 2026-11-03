import { Link } from "react-router";
import { StatusCell, type ColumnDef } from "~/components/data-grid";
import type { RoomListRow } from "~/domains/rooms/rooms.queries.server";
import type { Translate } from "~/i18n";

const dash = <span className="text-muted-foreground">—</span>;

export function roomColumns(t: Translate): ColumnDef<RoomListRow>[] {
  return [
    {
      accessorKey: "roomNumber",
      header: t("rooms.col.roomNumber"),
      size: 120,
      cell: ({ row }) =>
        row.original.roomNumber ? <span className="nums">{row.original.roomNumber}</span> : dash,
    },
    {
      accessorKey: "name",
      header: t("rooms.col.name"),
      size: 260,
      cell: ({ row }) => (
        <Link to={`/rooms/${row.original.slug}`} className="hover:underline">
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: "campusName",
      header: t("rooms.col.campus"),
      cell: ({ row }) => <span className="text-sm">{row.original.campusName ?? "—"}</span>,
    },
    {
      accessorKey: "status",
      header: t("rooms.col.status"),
      size: 150,
      cell: ({ row }) => <StatusCell kind="room" value={row.original.status} />,
    },
    {
      accessorKey: "capacity",
      header: t("rooms.col.capacity"),
      size: 90,
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
      size: 90,
      cell: ({ row }) => <span className="nums">{row.original.equipmentCount}</span>,
    },
  ];
}
