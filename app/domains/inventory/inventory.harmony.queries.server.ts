import { db } from "~/lib/db.server";
import type { Prisma } from "~/generated/prisma/client";

/**
 * The harmony link, read from both sides.
 *
 * "`equipmentId` is the link that makes the two families live in harmony: an AV
 * mixer **is** an `Equipment` (typed, fixed/pooled, with a `Room`) **and** an
 * `InventoryItem` (stock-keeping view)."
 *
 * ⚠️ **This file holds NO write, and that is a requirement rather than a stylistic
 * choice.** The link is maintained by `linkStockItemToEquipment` /
 * `unlinkStockItemFromEquipment` in `inventory.stock.mutations.server.ts`; this
 * module only reads it. Both families already live in `app/domains/inventory/`,
 * so a read here is not a cross-domain read either — and the alternative
 * (`app/domains/stock/`, named after the thing it serves rather than the domain
 * that owns it) would have made maintaining the link a cross-domain write, which
 * the domain-ownership rule bans.
 *
 * Read-only, so no transaction is opened here — the same seam
 * `inventory.stock.queries.server.ts` uses. Every mutating caller opens its own
 * through `txWithAudit`.
 */

/**
 * What a caller sees of the *other* side of the link.
 *
 * `equipment` is deliberately absent from the stock rows {@link listStockForEquipment}
 * returns: `equipmentId` already selected them, so joining the parent back onto
 * each row would be a second copy of the id every caller already has. The vendor
 * and location joins are kept, because a stock list rendered next to a device
 * needs those, and the stock queries apply the same rule to their own lists.
 */
const HARMONY_STOCK_SELECT = {
  id: true,
  name: true,
  sku: true,
  serial: true,
  quantity: true,
  unit: true,
  location: { select: { id: true, name: true, kind: true } },
  vendor: { select: { id: true, name: true } },
} satisfies Prisma.InventoryItemSelect;

/** The equipment a caller needs to render the other side of the link. */
const HARMONY_EQUIPMENT_SELECT = {
  id: true,
  name: true,
  assetTag: true,
  category: true,
  status: true,
  mobility: true,
} satisfies Prisma.EquipmentSelect;

/**
 * Equipment → its stock items.
 *
 * The reverse half of the harmony claim, and the one a device's detail page
 * reads. `name` then `id` is the stable order the stock queries use, repeated
 * verbatim: `name` is not unique, so ordering by it alone leaves two identical
 * queries free to return the same rows in different orders.
 */
export async function listStockForEquipment(equipmentId: string) {
  return db.inventoryItem.findMany({
    where: { equipmentId },
    select: HARMONY_STOCK_SELECT,
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/**
 * Stock item → its equipment, or `null` when the item is unlinked.
 *
 * ⚠️ **`null` is a real answer here, not a failure.** Most loose stock carries
 * no `equipmentId` at all (the link is optional, `String?`),
 * so "this item is not a device" is the majority case in a stock list. A reader
 * that treated it as an error would have to invent one.
 */
export async function getEquipmentForStockItem(itemId: string) {
  return db.inventoryItem
    .findUnique({
      where: { id: itemId },
      select: { id: true, name: true, equipment: { select: HARMONY_EQUIPMENT_SELECT } },
    })
    .then((row) => row?.equipment ?? null);
}
