import { NotFoundError, ValidationError, hasSqlState } from "~/lib/errors.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { type Tx } from "~/lib/db.server";
import { tr } from "~/i18n/request-locale.server";
import type { InventoryItem } from "~/generated/prisma/client";
import type { StockCreateInput, StockEditInput } from "./inventory.stock.schema";

/**
 * Stock mutations. Every one runs through `txWithAudit`, so the
 * `ActivityLog` row commits with the change or not at all — the append-only audit
 * spine, and what `guards.sh` #2 protects.
 *
 * **A refused mutation writes nothing — not the change, and not an audit row**.
 * A duplicate `sku`/`serial` is the refusal this file exists to render:
 * the uniqueness lives in the DATABASE, so the error arrives from Postgres
 * after the statement is issued, and the domain's job is to translate it.
 *
 * The last two functions own the **harmony link** — the one writer
 * of `InventoryItem.equipmentId`. The read side is
 * `inventory.harmony.queries.server.ts`; the constraint that keeps the link from
 * dangling is the database's `Restrict` FK, and this file's job is to translate it
 * rather than to enforce it.
 */

/**
 * Postgres `restrict_violation` — the SQLSTATE the `InventoryItem.equipmentId`
 * `Restrict` FK raises when the referenced `Equipment` row is deleted. Prisma reports it
 * as `P2003`, and `hasSqlState` finds the SQLSTATE on the adapter cause.
 */
const SQLSTATE_RESTRICT_VIOLATION = "23001";

/**
 * The two audit actions the harmony link writes.
 *
 * ⚠️ **One name per operation, deliberately, and the reason is the label budget.**
 * The `history.action.*` catalog grants exactly **two** labels to the harmony link,
 * and the feed keys on `action` alone. So the `inventory-item` row and the `equipment`
 * row of a single link must share one action name, or the row's own budget would be
 * four. What tells the two rows apart is `entityType` — which is the column
 * `listEntityHistory` filters on, and the column the two shipped feeds already
 * pass (`ENTITY_TYPE.equipment` at `_desktop.inventory.$id/route.tsx:58`).
 *
 * Exported so the test that proves the German labels exist is driven by the names
 * this file actually writes, rather than by a copy of them that a rename could
 * quietly desynchronise.
 */
export const HARMONY_ACTION = {
  linked: "EquipmentStockLinked",
  unlinked: "EquipmentStockUnlinked",
} as const;

/**
 * Is this error the `equipmentId` foreign key refusing?
 *
 * A raw `UPDATE` onto a non-existent `equipmentId` raises:
 *
 * ```
 * PrismaClientKnownRequestError { code: "P2003", meta: { driverAdapterError: { name: "DriverAdapterError",
 *   cause: { originalCode: "23503", kind: "ForeignKeyConstraintViolation",
 *            constraint: { index: "InventoryItem_equipmentId_fkey" } } } } }
 * ```
 *
 * Both the Prisma code `P2003` and the adapter `kind` are accepted below: the code is the
 * general handle, the `kind` and the named constraint are the precise one. `23001` — the
 * *other* FK direction, `Restrict` on the parent — is raised only by deleting an
 * `Equipment`, which the product never does, and is a different statement entirely.
 *
 * **Exported for the one test that can feed it a real violation.** The race this
 * backstop closes (a parent deleted between the pre-check and the UPDATE) is real
 * but cannot be staged from inside the domain call itself; the test stages the
 * interleaving by hand and hands the resulting error to this function.
 */
export function isEquipmentFkViolation(error: unknown): boolean {
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 6; depth++) {
    const e = cur as {
      code?: unknown;
      meta?: {
        driverAdapterError?: { cause?: { kind?: unknown; constraint?: { index?: unknown } } };
      };
    };
    const cause = e.meta?.driverAdapterError?.cause;
    if (e.code === "P2003") {
      // The update below writes exactly one column, so a FK violation here can
      // only be the equipmentId one — but assert the constraint anyway when the
      // driver named it, so a future column cannot be silently reclassified here.
      const index = cause?.constraint?.index;
      return index === undefined || index === "InventoryItem_equipmentId_fkey";
    }
    if (cause?.kind === "ForeignKeyConstraintViolation") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Prisma's own code for a unique violation, and the adapter's kind discriminator.
 *
 * On this stack a duplicate is reported as `P2002`, with the adapter cause carrying the
 * SQLSTATE (`originalCode`, read by `hasSqlState`), the kind, and the named constraint:
 *
 * ```
 * PrismaClientKnownRequestError { code: "P2002", meta: {
 *   modelName: "InventoryItem",
 *   driverAdapterError: { name: "DriverAdapterError", cause: {
 *     originalCode: "23505", kind: "UniqueConstraintViolation",
 *     constraint: { index: "InventoryItem_sku_key" },
 *     originalMessage: 'duplicate key value violates unique constraint "InventoryItem_sku_key"' } } } }
 * ```
 *
 * Both the Prisma code and the adapter `kind` are accepted, because they are the two shapes
 * this stack produces depending on whether the failure arrives from a single statement or a
 * `createMany`.
 */
function isUniqueViolation(error: unknown): boolean {
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 6; depth++) {
    const e = cur as {
      code?: unknown;
      meta?: { driverAdapterError?: { cause?: { kind?: unknown } } };
    };
    if (e.code === "P2002") return true;
    if (e.meta?.driverAdapterError?.cause?.kind === "UniqueConstraintViolation") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The **field** that collided, read from the adapter's structured constraint: the column in
 * `constraint.fields[0]` where the adapter names one, or the index name where it names the
 * index (7.10 does this for unique violations). The fallbacks are in descending order of
 * trust: Prisma's `meta.target`, then the constraint *name* in the message, then nothing.
 *
 * A returned `null` is not a failure — it produces an unlabelled `ValidationError`,
 * which is still a 422 with a usable message. A *mislabelled* one would be worse:
 * telling a user their serial is taken when their sku is.
 */
export function collidedField(error: unknown): "sku" | "serial" | null {
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 6; depth++) {
    const e = cur as {
      meta?: {
        target?: unknown;
        driverAdapterError?: { cause?: { constraint?: { fields?: unknown; index?: unknown } } };
      };
      message?: unknown;
      cause?: unknown;
    };
    const constraint = e.meta?.driverAdapterError?.cause?.constraint;
    const fields = constraint?.fields;
    if (Array.isArray(fields) && typeof fields[0] === "string") {
      if (fields[0] === "sku" || fields[0] === "serial") return fields[0];
    }
    const index = constraint?.index;
    if (typeof index === "string") {
      if (/_sku_key$/i.test(index)) return "sku";
      if (/_serial_key$/i.test(index)) return "serial";
    }
    const target = e.meta?.target;
    const candidate = Array.isArray(target)
      ? target[0]
      : typeof target === "string"
        ? target
        : null;
    if (candidate === "sku" || candidate === "serial") return candidate;
    if (typeof e.message === "string") {
      if (/_sku_key/i.test(e.message)) return "sku";
      if (/_serial_key/i.test(e.message)) return "serial";
    }
    cur = e.cause;
  }
  return null;
}

/**
 * Turn a unique violation into a `ValidationError` naming the field. The value
 * that collided is quoted back, because "SKU wird bereits verwendet" is a form
 * error the user can act on and a raw `23505` is not.
 */
function rethrowAsFieldError(error: unknown, input: { sku?: string; serial?: string }): never {
  const field = collidedField(error);
  const value = field ? input[field] : undefined;
  const label = tr(
    field === "serial" ? "places.err.stock.label.serial" : "places.err.stock.label.sku",
  );
  if (field && value) {
    throw new ValidationError({
      [field]: [tr("places.err.stock.uniqueValueTaken", { label, value })],
    });
  }
  if (field) {
    throw new ValidationError({
      [field]: [tr("places.err.stock.uniqueTaken", { label })],
    });
  }
  throw new ValidationError({}, [tr("places.err.stock.uniqueKeyDuplicate")]);
}

/** 1 — a foreign key that is not a real row. Checked before anything is written. */
async function requireRefs(
  tx: Tx,
  input: { vendorId?: string; locationId?: string; equipmentId?: string },
): Promise<void> {
  if (input.vendorId) {
    const vendor = await tx.vendor.findUnique({
      where: { id: input.vendorId },
      select: { id: true },
    });
    if (!vendor) throw new ValidationError({ vendorId: [tr("places.err.vendor.unknown")] });
  }
  if (input.locationId) {
    const location = await tx.location.findUnique({
      where: { id: input.locationId },
      select: { id: true },
    });
    if (!location) throw new ValidationError({ locationId: [tr("places.err.location.unknown")] });
  }
  if (input.equipmentId) {
    const equipment = await tx.equipment.findUnique({
      where: { id: input.equipmentId },
      select: { id: true },
    });
    if (!equipment)
      throw new ValidationError({ equipmentId: [tr("places.err.equipment.unknown")] });
  }
}

/** The `data` half shared by create and edit, so the two cannot drift. */
function stockData(input: StockCreateInput) {
  return {
    name: input.name,
    sku: input.sku ?? null,
    serial: input.serial ?? null,
    quantity: input.quantity ?? 1,
    category: input.category ?? null,
    status: input.status ?? null,
    unit: input.unit ?? null,
    purchasedAt: input.purchasedAt ?? null,
    purchasePrice: input.purchasePrice ?? null,
    warrantyExpiresAt: input.warrantyExpiresAt ?? null,
    vendorId: input.vendorId ?? null,
    locationId: input.locationId ?? null,
    equipmentId: input.equipmentId ?? null,
    tags: input.tags ?? [],
  };
}

/**
 * 🔴 **One row, in a caller-supplied transaction — and the only place a stock row
 * is written.** `createStockItem` below is the audited single-item wrapper; the CSV
 * importer in `inventory.stock.import.server.ts` is the batch caller, which runs
 * un-audited and therefore must not open a transaction per row.
 *
 * **The shared sequence lives HERE, so the mapping and its error translation cannot
 * fork.** The importer has to insert through *"the same `stockData()` mapping the
 * domain uses"* and let a duplicate surface through the database's unique constraint
 * — but `stockData`, `requireRefs` and `rethrowAsFieldError` are all private to this
 * module. **Exporting the three internals instead would defeat that purpose:** the
 * importer would own a *second* copy of the create-then-translate sequence, which is
 * exactly the drift the shared sequence prevents. So the sequence is extracted here
 * and both callers run it, which is the only shape that keeps `createStockItem`'s
 * behaviour and the importer's rows identical. The suite below is what proves that
 * behaviour.
 *
 * The caller owns the audit row, because only the caller knows whether the change
 * is one item or a file of them — and the harmony link's two-rows-per-write rule is
 * the precedent for a write whose audit shape is not one row.
 */
export async function createStockInTx(
  tx: Tx,
  input: StockCreateInput,
  createdById?: string | null,
): Promise<InventoryItem> {
  await requireRefs(tx, input);
  try {
    return await tx.inventoryItem.create({
      data: { ...stockData(input), createdById: createdById ?? null },
    });
  } catch (error) {
    // The unique index is the arbiter — a pre-flight "does this sku already exist?"
    // would pass every test and still be wrong under concurrency, because the check
    // and the insert are not one atomic step.
    if (isUniqueViolation(error)) rethrowAsFieldError(error, input);
    throw error;
  }
}

export async function createStockItem(
  actor: AuditActor,
  input: StockCreateInput,
): Promise<InventoryItem> {
  return txWithAudit(actor, async (tx, audit) => {
    const item = await createStockInTx(tx, input, actor?.id ?? null);
    await audit({
      action: "InventoryItemCreated",
      entityType: "inventory-item",
      entityId: item.id,
      data: {
        name: item.name,
        sku: item.sku,
        serial: item.serial,
        quantity: item.quantity,
        unit: item.unit,
      },
    });
    return item;
  });
}

export async function updateStockItem(
  actor: AuditActor,
  id: string,
  input: StockEditInput,
): Promise<InventoryItem> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.inventoryItem.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("places.err.stock.notFound"));
    await requireRefs(tx, input);

    let item: InventoryItem;
    try {
      item = await tx.inventoryItem.update({ where: { id }, data: stockData(input) });
    } catch (error) {
      if (isUniqueViolation(error)) rethrowAsFieldError(error, input);
      throw error;
    }
    await audit({
      action: "InventoryItemUpdated",
      entityType: "inventory-item",
      entityId: item.id,
      // Only what actually moved — an update that rewrites identical values is
      // not a change worth a second reading in /activity.
      data: {
        from: {
          name: before.name !== item.name ? before.name : undefined,
          sku: before.sku !== item.sku ? before.sku : undefined,
          serial: before.serial !== item.serial ? before.serial : undefined,
          quantity: before.quantity !== item.quantity ? before.quantity : undefined,
          locationId: before.locationId !== item.locationId ? before.locationId : undefined,
          vendorId: before.vendorId !== item.vendorId ? before.vendorId : undefined,
          equipmentId: before.equipmentId !== item.equipmentId ? before.equipmentId : undefined,
        },
        to: { name: item.name, sku: item.sku, serial: item.serial, quantity: item.quantity },
      },
    });
    return item;
  });
}

/**
 * Delete a stock item.
 *
 * ⚠️ **Refused while `equipmentId` points at an `Equipment`**
 * (`Restrict` — "equipment is never hard-deleted while stock references it"). The
 * refusal is the explicit `deleteLinked` check on the row as read;
 * `unlinkStockItemFromEquipment` below is what detaches the item, and that is the
 * only supported route.
 */
export async function deleteStockItem(actor: AuditActor, id: string): Promise<InventoryItem> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.inventoryItem.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("places.err.stock.notFound"));

    if (before.equipmentId) {
      throw new ValidationError({}, [tr("places.err.stock.deleteLinked", { name: before.name })]);
    }

    let deleted: InventoryItem;
    try {
      deleted = await tx.inventoryItem.delete({ where: { id } });
    } catch (error) {
      // Defensive only: the equipmentId FK restricts deleting the Equipment, not
      // this row, so no current statement raises 23001 here.
      if (hasSqlState(error, SQLSTATE_RESTRICT_VIOLATION)) {
        throw new ValidationError({}, [
          tr("places.err.stock.deleteRacedLink", { name: before.name }),
        ]);
      }
      throw error;
    }
    await audit({
      action: "InventoryItemDeleted",
      entityType: "inventory-item",
      entityId: id,
      data: {
        name: deleted.name,
        sku: deleted.sku,
        serial: deleted.serial,
        quantity: deleted.quantity,
      },
    });
    return deleted;
  });
}

/**
 * Link a stock item to an Equipment — the harmony link, "the link that makes
 * the two families live in harmony", written in the one place that owns it.
 *
 * 🔴 **TWO audit rows per link, not one, and the reason is a page that
 * already ships.** `ActivityLog` carries a single `entityType`/`entityId` pair and
 * `listEntityHistory` filters on exactly that pair, so "one row naming both
 * entities" has exactly one writable shape — the counterpart riding in free-form
 * `data` — and under it the **equipment detail page renders nothing at all** for
 * the link this function exists to create (`_desktop.inventory.$id/route.tsx:58`
 * passes `ENTITY_TYPE.equipment` to the same reader). One row per side, each
 * naming the other in `data`, means the per-entity feeds interleave both families
 * with no mapping at all — the documented half of the harmony claim, which
 * needed no fix only because the write side is honest about it.
 *
 * **Both rows commit with the link, or neither does**: they are two `audit()`
 * calls inside the one `txWithAudit` above, so the audit-in-same-transaction
 * invariant (`guards.sh` #2) covers them exactly as it covers a single row.
 */
export async function linkStockItemToEquipment(
  actor: AuditActor,
  itemId: string,
  equipmentId: string,
): Promise<InventoryItem> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.inventoryItem.findUnique({ where: { id: itemId } });
    if (!before) throw new NotFoundError(tr("places.err.stock.notFound"));

    // One link per item, and a change of mind goes through `unlink` first.
    // Written as a refusal, not a silent overwrite, because a re-point is
    // two events and only the second one would otherwise be recorded.
    if (before.equipmentId === equipmentId) {
      throw new ValidationError({}, [
        tr("places.err.stock.alreadyLinkedThis", { name: before.name }),
      ]);
    }
    if (before.equipmentId) {
      throw new ValidationError({}, [
        tr("places.err.stock.alreadyLinkedOther", { name: before.name }),
      ]);
    }

    // The dangling-link check, before anything is written — the same order
    // `createStockItem` uses, and the same field-level message.
    await requireRefs(tx, { equipmentId });

    const equipment = await tx.equipment.findUniqueOrThrow({ where: { id: equipmentId } });

    let item: InventoryItem;
    try {
      item = await tx.inventoryItem.update({ where: { id: itemId }, data: { equipmentId } });
    } catch (error) {
      // Backstop for the race the read cannot close: another writer can delete
      // the Equipment between `requireRefs` and this UPDATE. Prisma reports that as
      // `P2003`, so the check is on the Prisma code and the adapter kind — see
      // `isEquipmentFkViolation`.
      if (isEquipmentFkViolation(error)) {
        throw new ValidationError({}, [
          tr("places.err.stock.linkTargetGone", { name: before.name }),
        ]);
      }
      throw error;
    }

    await audit({
      action: HARMONY_ACTION.linked,
      entityType: "inventory-item",
      entityId: item.id,
      data: { name: item.name, equipmentId, equipmentName: equipment.name },
    });
    await audit({
      action: HARMONY_ACTION.linked,
      entityType: "equipment",
      entityId: equipmentId,
      data: { stockItemId: item.id, stockItemName: item.name },
    });
    return item;
  });
}

/**
 * Unlink — the only supported way to detach an item: once unlinked, the parent is
 * free and the stock row goes on its own terms (`deleteStockItem` above).
 *
 * Symmetric with {@link linkStockItemToEquipment} in every respect that matters:
 * two rows, same action on both sides, each naming the other, one transaction.
 * An item with no link is a **refusal** rather than a no-op, so that "nothing
 * happened" is never recorded as something that did.
 */
export async function unlinkStockItemFromEquipment(
  actor: AuditActor,
  itemId: string,
): Promise<InventoryItem> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.inventoryItem.findUnique({ where: { id: itemId } });
    if (!before) throw new NotFoundError(tr("places.err.stock.notFound"));
    if (!before.equipmentId) {
      throw new ValidationError({}, [tr("places.err.stock.notLinked", { name: before.name })]);
    }

    // Read the counterpart BEFORE clearing it, because the equipment-side audit
    // row has to name the item and this is the only moment the link is visible.
    const equipment = await tx.equipment.findUnique({ where: { id: before.equipmentId } });

    const item = await tx.inventoryItem.update({
      where: { id: itemId },
      data: { equipmentId: null },
    });

    await audit({
      action: HARMONY_ACTION.unlinked,
      entityType: "inventory-item",
      entityId: item.id,
      data: {
        name: item.name,
        equipmentId: before.equipmentId,
        equipmentName: equipment?.name ?? null,
      },
    });
    if (before.equipmentId) {
      await audit({
        action: HARMONY_ACTION.unlinked,
        entityType: "equipment",
        entityId: before.equipmentId,
        data: { stockItemId: item.id, stockItemName: item.name },
      });
    }
    return item;
  });
}
