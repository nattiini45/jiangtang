import { Link } from "react-router";
import { DateCell, MonoCell, type ColumnDef } from "~/components/data-grid";
import { LocationKindText, StockStatusText } from "~/components/i18n/enum-text";
import type { StockStatus } from "~/generated/prisma/enums";
import type { Translate } from "~/i18n";
import { kindLabel } from "~/components/locations/labels";

/**
 * DataGrid columns for the stock list.
 *
 * ⚠️ **`location` / `vendor` / `equipment` are columns here because the query already
 * joins them** (`STOCK_INCLUDE` in `inventory.stock.queries.server.ts`) — not because a
 * column is a nice thing to have. A stock list that made the user open each item to learn
 * where it is or who supplied it would satisfy a URL guard and nothing else. One query, no
 * N+1, three joins visible at once.
 *
 * **The row links to `/inventory/stock/:id`, never to `/inventory/:id`.** The second one
 * is the Equipment detail page, and `/inventory/stock` must never fall through to it;
 * `test/routes/route-resolution.test.ts` guards the distinction, and this link is one of
 * the producers that make it load-bearing.
 */

const dash = <span className="text-muted-foreground">—</span>;

/** The row shape `listStock` returns with `STOCK_INCLUDE`. */
export interface StockListRow {
  id: string;
  name: string;
  sku: string | null;
  serial: string | null;
  quantity: number;
  unit: string | null;
  category: string | null;
  status: StockStatus | null;
  warrantyExpiresAt: Date | null;
  location: { id: string; name: string; kind: string } | null;
  vendor: { id: string; name: string } | null;
  equipment: { id: string; name: string | null; assetTag: string | null } | null;
}

export function stockColumns(t: Translate): ColumnDef<StockListRow>[] {
  return [
    {
      accessorKey: "name",
      header: t("inventory.stock.col.item"),
      size: 240,
      cell: ({ row }) => (
        <Link to={`/inventory/stock/${row.original.id}`} className="hover:underline">
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: "quantity",
      header: t("inventory.stock.col.quantity"),
      size: 90,
      cell: ({ row }) => (
        <span className="nums text-sm">
          {/* Quantity without its unit is half a number — "3" of what? The unit is a
            nullable free string, so this is a join, not a format. */}
          {row.original.quantity}
          {row.original.unit ? ` ${row.original.unit}` : ""}
        </span>
      ),
    },
    {
      accessorKey: "sku",
      header: t("inventory.stock.col.sku"),
      size: 130,
      cell: ({ row }) => (row.original.sku ? <MonoCell>{row.original.sku}</MonoCell> : dash),
    },
    {
      accessorKey: "serial",
      header: t("inventory.stock.col.serial"),
      size: 150,
      cell: ({ row }) => (row.original.serial ? <MonoCell>{row.original.serial}</MonoCell> : dash),
    },
    {
      accessorKey: "location",
      meta: {
        searchText: (row, locale) =>
          row.location
            ? `${row.location.name} ${kindLabel(locale, row.location.kind)}`
            : t("inventory.stock.col.unassigned"),
      },
      header: t("inventory.stock.col.location"),
      cell: ({ row }) =>
        row.original.location ? (
          <Link to={`/locations/${row.original.location.id}`} className="text-sm hover:underline">
            {row.original.location.name}
            <span className="text-muted-foreground ml-1 text-xs">
              <LocationKindText kind={row.original.location.kind} />
            </span>
          </Link>
        ) : (
          // "Assigned nowhere" is a stock state worth seeing (the `includeUnassigned`
          // rationale), so the list names it rather than rendering an empty cell.
          <span className="text-muted-foreground text-sm">
            {t("inventory.stock.col.unassigned")}
          </span>
        ),
    },
    {
      accessorKey: "vendor",
      meta: { searchText: (row) => row.vendor?.name },
      header: t("inventory.stock.col.vendor"),
      cell: ({ row }) =>
        row.original.vendor ? <span className="text-sm">{row.original.vendor.name}</span> : dash,
    },
    {
      accessorKey: "equipment",
      meta: {
        searchText: (row) =>
          row.equipment
            ? (row.equipment.name ??
              row.equipment.assetTag ??
              t("inventory.stock.detail.deviceFallback"))
            : null,
      },
      header: t("inventory.stock.col.device"),
      cell: ({ row }) =>
        row.original.equipment ? (
          // Equipment detail, which is what `/inventory/:id` has always meant.
          <Link to={`/inventory/${row.original.equipment.id}`} className="text-sm hover:underline">
            {row.original.equipment.name ??
              row.original.equipment.assetTag ??
              t("inventory.stock.detail.deviceFallback")}
          </Link>
        ) : (
          dash
        ),
    },
    {
      accessorKey: "status",
      meta: { searchText: (row) => (row.status ? t(`status.stock.${row.status}`) : null) },
      header: t("inventory.stock.col.status"),
      size: 200,
      // The localized label, not the enum key — nobody reads ON_LOAN.
      cell: ({ row }) =>
        row.original.status ? (
          <span className="text-sm">
            <StockStatusText value={row.original.status} />
          </span>
        ) : (
          dash
        ),
    },
    {
      accessorKey: "warrantyExpiresAt",
      header: t("inventory.stock.col.warranty"),
      size: 140,
      // A warranty date, not a warranty *state*: "expiring soon" is a judgement the
      // expiry sweep owns, and a list that computed its own would disagree with it.
      cell: ({ row }) => <DateCell value={row.original.warrantyExpiresAt} withTime={false} />,
    },
  ];
}
