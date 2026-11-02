import { Link } from "react-router";
import type { ColumnDef } from "~/components/data-grid";
import type { ModelListRow } from "~/domains/catalog/catalog.queries.server";
import type { Translate } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import { categoryLabel } from "./labels";

export function modelColumns(t: Translate, locale: Locale): ColumnDef<ModelListRow>[] {
  return [
    {
      accessorKey: "manufacturer",
      header: t("inventory.col.manufacturer"),
      cell: ({ row }) => <span className="text-sm">{row.original.manufacturer ?? "—"}</span>,
    },
    {
      accessorKey: "name",
      header: t("inventory.col.model"),
      cell: ({ row }) => (
        <Link to={`/inventory/models/${row.original.id}`} className="hover:underline">
          {row.original.name}
        </Link>
      ),
      size: 240,
    },
    {
      accessorKey: "category",
      header: t("inventory.col.category"),
      cell: ({ row }) => (
        <span className="text-sm">{categoryLabel(locale, row.original.category)}</span>
      ),
    },
    {
      accessorKey: "instanceCount",
      header: t("inventory.col.devices"),
      cell: ({ row }) => <span className="nums text-sm">{row.original.instanceCount}</span>,
      size: 90,
    },
    {
      accessorKey: "faultyCount",
      header: t("inventory.col.faulty"),
      size: 90,
      cell: ({ row }) =>
        row.original.faultyCount > 0 ? (
          <span className="text-status-fault nums text-sm">{row.original.faultyCount}</span>
        ) : (
          <span className="text-muted-foreground nums text-sm">0</span>
        ),
    },
  ];
}
