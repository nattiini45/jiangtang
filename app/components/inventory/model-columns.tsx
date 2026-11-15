import { Link } from "react-router";
import type { ColumnDef } from "~/components/data-grid";
import type { ModelListRow } from "~/domains/catalog/catalog.queries.server";
import type { Translate } from "~/i18n";
import type { Locale } from "~/i18n/locales";

export function modelColumns(t: Translate, _locale: Locale): ColumnDef<ModelListRow>[] {
  return [
    {
      accessorKey: "manufacturer",
      header: t("inventory.col.manufacturer"),
      cell: ({ row }) => (
        <span className="truncate text-sm" title={row.original.manufacturer ?? undefined}>
          {row.original.manufacturer ?? "—"}
        </span>
      ),
    },
    {
      accessorKey: "name",
      header: t("inventory.col.model"),
      cell: ({ row }) => (
        <Link
          to={`/inventory/models/${row.original.id}`}
          className="truncate hover:underline"
          title={row.original.name}
        >
          {row.original.name}
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
      accessorKey: "instanceCount",
      meta: { sizing: "short" },
      header: t("inventory.col.devices"),
      cell: ({ row }) => <span className="nums text-sm">{row.original.instanceCount}</span>,
    },
    {
      accessorKey: "faultyCount",
      meta: { sizing: "short" },
      header: t("inventory.col.faulty"),
      cell: ({ row }) =>
        row.original.faultyCount > 0 ? (
          <span className="text-status-fault nums text-sm">{row.original.faultyCount}</span>
        ) : (
          <span className="text-muted-foreground nums text-sm">0</span>
        ),
    },
  ];
}
