import { Link } from "react-router";
import { MonoCell, StatusCell, type ColumnDef } from "~/components/data-grid";
import type { EquipmentListRow } from "~/domains/inventory/inventory.queries.server";
import type { Translate } from "~/i18n";
import type { Locale } from "~/i18n/locales";

const dash = <span className="text-muted-foreground">—</span>;

export function equipmentColumns<T extends EquipmentListRow = EquipmentListRow>(
  t: Translate,
  _locale: Locale,
): ColumnDef<T>[] {
  return [
    {
      accessorKey: "name",
      meta: { searchText: (row) => row.name ?? row.modelName ?? row.kind.name },
      header: t("inventory.col.device"),
      cell: ({ row }) => (
        <Link
          to={`/inventory/${row.original.id}`}
          className="truncate hover:underline"
          title={row.original.name ?? row.original.modelName ?? row.original.kind.name}
        >
          {row.original.name ?? row.original.modelName ?? row.original.kind.name}
        </Link>
      ),
    },
    {
      id: "kind",
      accessorFn: (row) => row.kind.name,
      meta: { searchText: (row) => row.kind.name },
      header: t("inventory.kind"),
      cell: ({ row }) => (
        <span className="truncate" title={row.original.kind.name}>
          {row.original.kind.name}
        </span>
      ),
    },
    {
      accessorKey: "assetTag",
      meta: { sizing: "short" },
      header: t("inventory.col.assetTag"),
      cell: ({ row }) =>
        row.original.assetTag ? <MonoCell>{row.original.assetTag}</MonoCell> : dash,
    },
    {
      accessorKey: "roomName",
      meta: { searchText: (row) => row.roomName || t("inventory.col.pool") },
      header: t("inventory.col.room"),
      cell: ({ row }) =>
        row.original.roomName ? (
          <Link
            to={`/rooms/${row.original.roomSlug}`}
            className="truncate hover:underline"
            title={row.original.roomName}
          >
            {row.original.roomName}
          </Link>
        ) : (
          <span className="text-muted-foreground">{t("inventory.col.pool")}</span>
        ),
    },
    {
      accessorKey: "modelName",
      header: t("inventory.col.model"),
      cell: ({ row }) => (
        <span className="truncate text-sm" title={row.original.modelName ?? undefined}>
          {row.original.modelName ?? "—"}
        </span>
      ),
    },
    {
      accessorKey: "status",
      meta: { sizing: "short", searchText: (row) => t(`status.equipment.${row.status}`) },
      header: t("inventory.col.status"),
      cell: ({ row }) => <StatusCell kind="equipment" value={row.original.status} />,
    },
  ];
}
