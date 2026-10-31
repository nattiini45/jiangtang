import { Link } from "react-router";
import { stockStatusLabel } from "~/components/inventory/labels";
import type { StockStatus } from "~/generated/prisma/enums";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * The stock at **one** location.
 *
 * ⚠️ **The panel owns its own heading, and that is the criterion rather than a style
 * choice.** The number in the heading is `items.length` — the same array this panel
 * draws — because the alternative (`countStockAtLocation`) needs a `Tx` a loader
 * cannot obtain and has no caller, so a count rendered next to the rows would be a
 * second query that could disagree with the rows it labels. One array, one number.
 *
 * **Two exclusions are stated on the surface, not left to the reader's inference.**
 * `InventoryItem.locationId` is `String?` with `onDelete: SetNull`, so:
 *
 *  - **the subtree is not folded in.** `listStockAtLocation` filters
 *    `locationId = this node`; a stocked building whose rooms hold the stock would
 *    otherwise read "0 Artikel" on a page that is about that building. The count
 *    means *here*, and the panel says so.
 *  - **an item assigned nowhere is not here.** `locationId = null` belongs to no
 *    location's panel — and the panel says that too, rather than implying that a
 *    location's count is the whole of the stock in the building. The unassigned
 *    rows are visible on `/inventory/stock`, which names them "Nicht zugeordnet".
 *
 * The sibling "Im Lager filtern" link targets the **stock** namespace's own filter
 * (`?location=`), which the stock route's loader honours. ⚠️ **That target is deliberately not
 * this set, and the difference is the point:** `stockListOptionsSchema` defaults
 * `includeUnassigned` to `true` (a deliberate choice — "assigned nowhere is a
 * stock state worth seeing"), so the location-scoped stock list reads
 * `locationId = X OR locationId IS NULL`. **The link is where the rows this panel
 * excludes are visible**, which is what turns the scope note below from a disclaimer
 * into a fact — the flag does bite, and a test pins that on
 * the surface this panel hands over to rather than on this panel's count.
 * `test/routes/location-stock-routes.test.ts` asserts the link's real contract; a
 * first draft asserted equality and failed, which is why the default is written down
 * here.
 *
 * Read-only by construction: no form, no action, no mutation. The rows link into
 * `/inventory/stock/:id` — never `/inventory/:id`, which is the Equipment detail
 * page (guarded by `test/routes/route-resolution.test.ts`).
 */

/** The subset of `listStockAtLocation`'s row this panel actually draws. */
export interface LocationStockRow {
  id: string;
  name: string;
  quantity: number;
  unit: string | null;
  sku: string | null;
  serial: string | null;
  status: StockStatus | null;
  vendor: { id: string; name: string } | null;
}

const dash = <span className="text-muted-foreground">—</span>;

export function LocationStock({
  items,
  locationId,
  hasDescendants,
}: {
  items: LocationStockRow[];
  locationId: string;
  /** Whether the node has children — the subtree note only makes sense then. */
  hasDescendants: boolean;
}) {
  const locale = useLocale();
  const t = useT();
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-mono text-sm">
          {t("locations.stock.heading")}{" "}
          <span className="text-muted-foreground">({items.length})</span>
        </h2>
        <Link
          to={`/inventory/stock?location=${locationId}`}
          className="text-muted-foreground text-xs hover:underline"
        >
          {t("locations.stock.filterLink")}
        </Link>
      </div>

      {/* The scope, in prose, because two different wrong readings are available and
          both of them look right on screen. */}
      <p className="text-muted-foreground text-xs">
        {hasDescendants ? `${t("locations.stock.descendantsNote")} ` : ""}
        {t("locations.stock.unassignedNote")}{" "}
        <Link to="/inventory/stock" className="hover:underline">
          {t("locations.stock.unassignedLink")}
        </Link>
        .
      </p>

      {items.length === 0 ? (
        <div className="border-border bg-border grid gap-px border">
          <p className="bg-background text-muted-foreground px-3 py-3 text-sm">
            {t("locations.stock.empty")}
          </p>
        </div>
      ) : (
        <ul className="border-border divide-border divide-y border">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <Link
                to={`/inventory/stock/${item.id}`}
                className="min-w-0 flex-1 truncate text-sm hover:underline"
              >
                {item.name}
              </Link>
              {/* Quantity without its unit is half a number, and `unit` is a nullable
                  free string — a join, not a format (`stock-columns.tsx`). */}
              <span className="font-mono text-xs">
                {item.quantity}
                {item.unit ? ` ${item.unit}` : ""}
              </span>
              {item.serial ? <span className="font-mono text-xs">{item.serial}</span> : null}
              {item.sku ? <span className="font-mono text-xs">{item.sku}</span> : null}
              {item.status ? (
                <span className="text-xs">{stockStatusLabel(locale, item.status)}</span>
              ) : null}
              {item.vendor ? (
                <span className="text-muted-foreground truncate text-xs">{item.vendor.name}</span>
              ) : (
                dash
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
