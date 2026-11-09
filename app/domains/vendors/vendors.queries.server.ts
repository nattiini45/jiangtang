import { db } from "~/lib/db.server";

/**
 * Vendors-domain queries (`Vendor`).
 *
 * This is a read-only module. The stock form's picker
 * needs a supplier list to exist, so that a bad supplier id is impossible rather
 * than merely unlikely, and this module is that list.
 *
 * ⚠️ **Read-only means no transaction is opened here** — every mutating caller opens its
 * own through `txWithAudit`. That is the same rule `locations.queries.server.ts`
 * states, and this module is deliberately its sibling in shape: a thin, typed,
 * read-only projection, much as `listLocationTree` is for locations.
 */

/**
 * One row of the supplier picker.
 *
 * ⚠️ **`id` and `name` only, and the narrowness is the point.** This is the projection a
 * `<select>` renders, so it selects the two fields the option needs and nothing else —
 * `email`/`phone`/`url`/`address` are all `String?` on the model and would each be a
 * nullable field the picker has no way to present. Widening this later is additive; the
 * alternative (returning the whole row and letting the component pick fields) is how a
 * component ends up reading a column the module never promised, and the break is silent
 * because TypeScript will happily widen a `Vendor` to a supertype.
 */
export interface VendorOption {
  id: string;
  name: string;
}

/**
 * Every vendor, ordered for a picker: `name` ascending, then `id`.
 *
 * ⚠️ **The `id` tiebreak is not decoration.** `Vendor.name` is a bare `String` with **no
 * unique index** (unlike `InventoryItem.sku`/`serial`, which are unique
 * specifically so a nullable-unique lookup could be a real selector) — so two suppliers
 * named identically are legal rows, and `ORDER BY name` alone leaves their relative order
 * to the planner. Two identical calls could then return the same rows in different
 * orders, which is the defect a "byte-identical ids" assertion catches and `listStock`
 * already guards against for the same reason. Ordering twice costs nothing and
 * makes the list reproducible.
 *
 * **No filter parameter, deliberately.** The `?vendor=` filter lives in
 * the route, and the route filters the *stock* list — `listStock` already accepts
 * `vendorId` (`stockListOptionsSchema`), so the filter needs nothing from this module.
 * Adding a `search` here to match would be a second, untested spelling of a control the
 * list route does not have.
 */
export async function listVendors(): Promise<VendorOption[]> {
  const rows = await db.vendor.findMany({
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  return rows;
}

/**
 * One vendor, or `null` — for a caller that has an id and wants the name behind it.
 *
 * ⚠️ **Not `NotFoundError`-throwing, and that asymmetry is deliberate.** `listVendors` is
 * the picker's data source; this is a lookup whose honest answer to "no such supplier" is
 * "none", which is what `getStockItem`/`findStockItemBySku` do in the stock module. A
 * throwing variant would be `requireVendor`, and nothing here needs it — the
 * *refusal* this row cares about, a `vendorId` that names no row, belongs to
 * `requireRefs` in the stock mutations, which is where a write is validated.
 */
export async function getVendor(id: string): Promise<VendorOption | null> {
  return db.vendor.findUnique({ where: { id }, select: { id: true, name: true } });
}

export function listVendorDetails(options: { q?: string; offset?: number; limit?: number } = {}) {
  return db.vendor.findMany({
    where: options.q ? { name: { contains: options.q, mode: "insensitive" } } : {},
    include: { location: { select: { id: true, name: true } } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    skip: options.offset,
    take: options.limit,
  });
}

export function getVendorDetail(id: string) {
  return db.vendor.findUnique({
    where: { id },
    include: { location: { select: { id: true, name: true } } },
  });
}
