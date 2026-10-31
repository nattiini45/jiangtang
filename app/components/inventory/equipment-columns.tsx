import { Link } from "react-router";
import { MonoCell, StatusCell, type ColumnDef } from "~/components/data-grid";
import type { EquipmentListRow } from "~/domains/inventory/inventory.queries.server";
import type { Translate } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import { categoryLabel } from "./labels";

const dash = <span className="text-muted-foreground">—</span>;

export function equipmentColumns(t: Translate, locale: Locale): ColumnDef<EquipmentListRow>[] {
  return [
    {
      accessorKey: "name",
      header: t("inventory.col.device"),
      size: 220,
      cell: ({ row }) => (
        <Link to={`/inventory/${row.original.id}`} className="hover:underline">
          {row.original.name ?? categoryLabel(locale, row.original.category)}
        </Link>
      ),
    },
    {
      accessorKey: "category",
      header: t("inventory.col.category"),
      cell: ({ row }) => (
        <span className="text-sm">{categoryLabel(locale, row.original.category)}</span>
      ),
    },
    {
      accessorKey: "assetTag",
      header: t("inventory.col.assetTag"),
      size: 140,
      cell: ({ row }) =>
        row.original.assetTag ? <MonoCell>{row.original.assetTag}</MonoCell> : dash,
    },
    {
      accessorKey: "roomName",
      header: t("inventory.col.room"),
      cell: ({ row }) =>
        row.original.roomName ? (
          <Link to={`/rooms/${row.original.roomSlug}`} className="hover:underline">
            {row.original.roomName}
          </Link>
        ) : (
          <span className="text-muted-foreground">{t("inventory.col.pool")}</span>
        ),
    },
    {
      accessorKey: "modelName",
      header: t("inventory.col.model"),
      cell: ({ row }) => <span className="text-sm">{row.original.modelName ?? "—"}</span>,
    },
    {
      accessorKey: "status",
      header: t("inventory.col.status"),
      size: 150,
      cell: ({ row }) => <StatusCell kind="equipment" value={row.original.status} />,
    },
  ];
}
