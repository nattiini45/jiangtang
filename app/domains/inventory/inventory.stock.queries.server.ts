import { db, type Tx } from "~/lib/db.server";
import { NotFoundError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import type { InventoryItem } from "~/generated/prisma/client";
import type { StockListOptions } from "./inventory.stock.schema";

/**
 * Stock queries (`InventoryItem`). Read-only, so no transaction is
 * opened here — every mutating caller opens its own through `txWithAudit`.
 *
 * ⚠️ **`findStockItemBySku` / `findStockItemBySerial` are the reason this file
 * exists in its present shape.** `sku` and `serial` are
 * `String?` *and* unique, and Prisma 7 emits
 * `InventoryItemWhereUniqueInput = AtLeast<{ id?; sku?; serial?; … },
 * "id" | "sku" | "serial">` — so a nullable unique is a **legal selector**, and
 * this module uses it directly. The alternative reading (add a surrogate unique,
 * or query by `findFirst` on a nullable field) is worse in both directions: a
 * surrogate key is a schema change this module does not own, and `findFirst` on a
 * unique column is a race dressed as a lookup — it cannot use the index the
 * `@@unique` created and would happily return a row a concurrent insert made
 * ambiguous.
 *
 * Both functions take `string`, never `string | null`. That is the generated
 * type talking, not a convention: the selector's keys are `sku?: string` /
 * `serial?: string` with **no** `| null`, so `findUnique({ where: { sku: null } })`
 * is a compile error. Asking "which item has no sku" is not a lookup, it is the
 * absence of a row — `listStock` is the answer to that question.
 */

/** The relation set a stock row is read with, so no caller N+1s a vendor/location. */
export const STOCK_INCLUDE = {
  location: { select: { id: true, name: true, kind: true } },
  vendor: { select: { id: true, name: true } },
  equipment: { select: { id: true, name: true, assetTag: true } },
} as const;

/** One stock item, or `null`. */
export async function getStockItem(id: string): Promise<InventoryItem | null> {
  return db.inventoryItem.findUnique({ where: { id } });
}

/** Like {@link getStockItem} but throws — for callers that cannot continue without it. */
export async function requireStockItem(id: string): Promise<InventoryItem> {
  const item = await getStockItem(id);
  if (!item) throw new NotFoundError(tr("places.err.stock.notFound"));
  return item;
}

/** One stock item with its vendor / location / equipment joined. */
export async function getStockItemWithRefs(id: string) {
  return db.inventoryItem.findUnique({ where: { id }, include: STOCK_INCLUDE });
}

/**
 * The item carrying this **sku**, or `null`. The selector is a
 * unique one, so at most one row can match and no ordering/limit is needed.
 */
export async function findStockItemBySku(sku: string) {
  return db.inventoryItem.findUnique({ where: { sku }, include: STOCK_INCLUDE });
}

/** The item carrying this **serial**, or `null`. Same reasoning as the sku lookup. */
export async function findStockItemBySerial(serial: string) {
  return db.inventoryItem.findUnique({ where: { serial }, include: STOCK_INCLUDE });
}

/**
 * Stock, filtered. `search` is a `contains` on the name (a human typing a word);
 * every other filter is an exact match on a foreign key.
 *
 * The stable order is `name` then `id`: `name` is not unique, so ordering by it
 * alone leaves the tie order up to the planner, and two identical queries can
 * return the same rows in different orders — the defect a "byte-identical ids"
 * assertion exists to catch. The `id` tiebreak is what makes a
 * repeated list reproducible.
 */
export async function listStock(options: StockListOptions = {} as StockListOptions) {
  // `includeUnassigned: false` excludes `locationId = null` with OR
  // without a location — before, the flag was consulted only inside the
  // `locationId` branch, so it was inert on a whole-stock list.
  const where = {
    ...(options.locationId
      ? options.includeUnassigned
        ? { OR: [{ locationId: options.locationId }, { locationId: null }] }
        : { locationId: options.locationId }
      : options.includeUnassigned === false
        ? { locationId: { not: null } }
        : {}),
    ...(options.vendorId ? { vendorId: options.vendorId } : {}),
    ...(options.equipmentId ? { equipmentId: options.equipmentId } : {}),
    ...(options.search ? { name: { contains: options.search, mode: "insensitive" as const } } : {}),
  };
  return db.inventoryItem.findMany({
    where,
    include: STOCK_INCLUDE,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/**
 * Stock **at one location** — the read side of the location panel.
 *
 * ⚠️ **Direct children only, and that is the requirement rather than a
 * shortcut.** The count is *at this location*, and an item whose
 * `locationId` is null must never be counted as being there — so this is
 * `locationId = $1` and nothing else. Subtree expansion, if it is ever wanted,
 * belongs to `locations.tree.server.ts` (which already owns the recursive walk)
 * and takes a `{ includeDescendants }` option; silently walking the
 * subtree here would double-count a panel that is also counting per-room rows.
 */
export async function listStockAtLocation(locationId: string) {
  return db.inventoryItem.findMany({
    where: { locationId },
    include: STOCK_INCLUDE,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/** How many stock rows point at a location, counted on the given transaction. */
export async function countStockAtLocation(tx: Tx, locationId: string): Promise<number> {
  return tx.inventoryItem.count({ where: { locationId } });
}
