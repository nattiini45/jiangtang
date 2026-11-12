import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import type { Tx } from "~/lib/db.server";
import {
  lockKindStructure,
  resolveEquipmentKind,
  type EquipmentKindInput,
} from "~/lib/equipment-kinds/kinds.server";
import { copyModelPortsInTx } from "./inventory.ports.mutations.server";
import { ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { findOrCreateModel } from "~/domains/catalog/catalog.mutations.server";
import type { Equipment, Prisma } from "~/generated/prisma/client";
import type { EquipmentCreateInput, EquipmentCsvRow } from "./inventory.schema";

type EquipmentWriteInput = Omit<EquipmentCreateInput, "category"> & EquipmentKindInput;

/**
 * Equipment mutations. FIXED units live in a room; POOLED units float (roomId
 * forced null). Retire-don't-delete (FK RESTRICT from allocations). Substitution
 * (spare → faulty) is 1:1, enforced by substitutingForId @unique.
 */

function equipmentFields(
  input: EquipmentCreateInput & { category: Equipment["category"] },
): Prisma.EquipmentUncheckedCreateInput {
  return {
    category: input.category,
    kindId: input.kindId,
    modelId: input.modelId ?? null,
    roomId: input.mobility === "POOLED" ? null : (input.roomId ?? null),
    mobility: input.mobility,
    status: input.status,
    name: input.name ?? null,
    assetTag: input.assetTag ?? null,
    serial: input.serial ?? null,
    hostname: input.hostname ?? null,
    ipAddress: input.ipAddress ?? null,
    macAddress: input.macAddress ?? null,
    dellServiceTag: input.dellServiceTag ?? null,
    dellExpressTag: input.dellExpressTag ?? null,
    micKind: input.micKind ?? null,
    frequencyMhz: input.frequencyMhz ?? null,
    band: input.band ?? null,
    channelLabel: input.channelLabel ?? null,
    lampType: input.lampType ?? null,
    lastLampChangeAt: input.lastLampChangeAt ?? null,
    color: input.color ?? null,
    attributes: input.attributes
      ? (JSON.parse(input.attributes) as Prisma.InputJsonValue)
      : undefined,
  };
}

export async function createEquipment(
  actor: AuditActor,
  source: EquipmentWriteInput,
): Promise<Equipment> {
  return txWithAudit(actor, async (tx, audit) => {
    const input = { ...source, ...(await resolveEquipmentKind(tx, source)) };
    const eq = await tx.equipment.create({ data: equipmentFields(input) });
    await copyModelPortsInTx(tx, eq.id, eq.modelId);
    await audit({
      action: "EquipmentCreated",
      entityType: "equipment",
      entityId: eq.id,
      data: { name: eq.name, category: eq.category, mobility: eq.mobility },
    });
    return eq;
  });
}

/**
 * The in-transaction `Equipment` writer, for a caller that already owns a `tx`.
 *
 * The domain-ownership rule binds on the domain folder: the `tx` that writes
 * a model is constructed by the folder that owns that model, and the audit row is
 * written there, in that same transaction. `rooms/` clones a room's gear, so the
 * clone's `Equipment` write belongs HERE and `rooms/` read-only imports it.
 *
 * Two properties this shape buys, both of which a move-the-write fix does not get
 * for free:
 *
 *   - the payload goes through `equipmentFields()`, so the clone cannot drift into
 *     a second, hand-maintained copy of the column list;
 *   - the `EquipmentCreated` row is written per unit, in the caller's transaction,
 *     so each copied unit is a row a reader can find. `RoomCloned`'s aggregate
 *     `copiedEquipment: N` stays as data on the room row — it is a summary, and a
 *     summary is not history.
 *
 * ⚠️ **It is not shaped like `createStockInTx`, and the difference is deliberate.**
 * That one leaves the audit row to its caller, because only the caller knows
 * whether the change is one item or a file of them (the two-rows-per-link rule).
 * An `Equipment` create is always exactly one unit, so the row's shape is
 * fixed and lives with the write.
 *
 * The caller supplies a fully-formed `EquipmentCreateInput`. Every optional
 * column it omits is written NULL by `equipmentFields()` — which is precisely how
 * a clone keeps the source unit's *kind* attributes while clearing its
 * unit-specific identifiers (asset tag, serial, hostname, IP, MAC, …): it simply
 * does not pass them.
 *
 * The `data` payload is the same three fields `createEquipment` writes. This path
 * adds no "came from a clone" flag, because nothing renders one yet and an unread
 * field is not a record — the row's *existence* is what was missing, and
 * that is what the per-unit write buys.
 */
export async function createEquipmentInTx(
  tx: Tx,
  audit: AuditFn,
  source: EquipmentWriteInput,
): Promise<Equipment> {
  const input = { ...source, ...(await resolveEquipmentKind(tx, source)) };
  const eq = await tx.equipment.create({ data: equipmentFields(input) });
  await copyModelPortsInTx(tx, eq.id, eq.modelId);
  await audit({
    action: "EquipmentCreated",
    entityType: "equipment",
    entityId: eq.id,
    data: { name: eq.name, category: eq.category, mobility: eq.mobility },
  });
  return eq;
}

export async function updateEquipment(
  actor: AuditActor,
  id: string,
  source: EquipmentWriteInput,
): Promise<Equipment> {
  return txWithAudit(actor, async (tx, audit) => {
    await lockKindStructure(tx);
    const current = await tx.equipment.findUniqueOrThrow({ where: { id } });
    const input = { ...source, ...(await resolveEquipmentKind(tx, source, current.kindId)) };
    const fields = equipmentFields(input);
    const { eq, auditData } =
      input.status === "RETIRED"
        ? await retireEquipmentInTx(tx, id, fields)
        : {
            eq: await tx.equipment.update({ where: { id }, data: fields }),
            auditData: undefined,
          };
    await audit({
      action: "EquipmentUpdated",
      entityType: "equipment",
      entityId: eq.id,
      data: auditData,
    });
    return eq;
  });
}

async function retireEquipmentInTx(
  tx: Tx,
  id: string,
  data: Prisma.EquipmentUncheckedUpdateInput = {},
) {
  const eq = await tx.equipment.update({
    where: { id },
    data: { ...data, status: "RETIRED", substitutingForId: null },
  });
  const clearedSpare = await tx.equipment.updateMany({
    where: { substitutingForId: id },
    data: { substitutingForId: null },
  });
  return {
    eq,
    auditData:
      clearedSpare.count > 0 ? { clearedSubstitutionLinks: clearedSpare.count } : undefined,
  };
}

/**
 * Retire (never delete — FK RESTRICT from allocations): status →
 * RETIRED. A retired unit can't remain part of an active substitution, so both
 * directions of the link are cleared in the same tx: this unit's own
 * `substitutingForId` (it was standing in for something) and any other unit's
 * `substitutingForId` that points at it (something was standing in for it).
 */
export async function retireEquipment(actor: AuditActor, id: string): Promise<Equipment> {
  return txWithAudit(actor, async (tx, audit) => {
    const { eq, auditData } = await retireEquipmentInTx(tx, id);
    await audit({
      action: "EquipmentRetired",
      entityType: "equipment",
      entityId: eq.id,
      data: auditData,
    });
    return eq;
  });
}

/**
 * Mark `spareId` as substituting for `faultyId` (or clear it). substitutingForId
 * is @unique, so a faulty unit can have at most one spare — a duplicate raises
 * P2002, surfaced as a friendly 422.
 */
export async function setSubstitution(
  actor: AuditActor,
  args: { spareId: string; faultyId?: string | null; clear?: boolean },
): Promise<Equipment> {
  return txWithAudit(actor, async (tx, audit) => {
    if (args.clear || !args.faultyId) {
      const existing = await tx.equipment.findUnique({
        where: { id: args.spareId },
        select: { id: true },
      });
      if (!existing) throw new ValidationError({ spareId: [tr("places.err.equipment.unknown")] });
      const eq = await tx.equipment.update({
        where: { id: args.spareId },
        data: { substitutingForId: null },
      });
      await audit({
        action: "EquipmentSubstitutionCleared",
        entityType: "equipment",
        entityId: eq.id,
      });
      return eq;
    }
    if (args.faultyId === args.spareId) {
      throw new ValidationError({ faultyId: [tr("places.err.equipment.selfSubstitute")] });
    }
    const target = await tx.equipment.findUnique({
      where: { id: args.faultyId },
      select: { status: true },
    });
    if (!target) throw new ValidationError({ faultyId: [tr("places.err.equipment.unknown")] });
    if (target.status === "RETIRED") {
      throw new ValidationError({
        faultyId: [tr("places.err.equipment.retiredTarget")],
      });
    }
    const spare = await tx.equipment.findUnique({
      where: { id: args.spareId },
      select: { status: true },
    });
    if (!spare) throw new ValidationError({ spareId: [tr("places.err.equipment.unknown")] });
    if (spare.status === "RETIRED" || spare.status === "FAULTY") {
      throw new ValidationError({
        spareId: [tr("places.err.equipment.badSpare")],
      });
    }
    try {
      const eq = await tx.equipment.update({
        where: { id: args.spareId },
        data: { substitutingForId: args.faultyId },
      });
      await audit({
        action: "EquipmentSubstitutionSet",
        entityType: "equipment",
        entityId: eq.id,
        data: { substitutingFor: args.faultyId },
      });
      return eq;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") {
        throw new ValidationError({
          faultyId: [tr("places.err.equipment.alreadySubstituted")],
        });
      }
      throw e;
    }
  });
}

/**
 * Bulk-create equipment from validated CSV rows in ONE transaction (whole-batch
 * atomic). `modell` is matched by name or auto-created; `raum` is matched by
 * slug / room number / name. A FIXED row with a missing/unknown room rolls the
 * whole import back with a clear message.
 */
export async function bulkCreateEquipment(
  actor: AuditActor,
  rows: (EquipmentCsvRow & { kindId?: string })[],
): Promise<{ created: number; items: Pick<Equipment, "id" | "name" | "category" | "assetTag">[] }> {
  return txWithAudit(
    actor,
    async (tx, audit) => {
      const items: Pick<Equipment, "id" | "name" | "category" | "assetTag">[] = [];
      for (const row of rows) {
        // `EquipmentModel` belongs to `catalog/`, so `catalog/` writes it — and it
        // writes it on OUR `tx`, or the model and its audit row would commit
        // outside this batch's rollback. The old inline create at
        // this spot was the cross-folder write the domain-ownership rule forbids.
        const modelId = row.modelText
          ? await findOrCreateModel(tx, audit, {
              name: row.modelText,
              category: row.category,
              kindId: row.kindId,
            })
          : null;

        let roomId: string | null = null;
        if (row.mobility === "FIXED") {
          if (!row.roomText) {
            throw new ValidationError({
              raum: [
                tr("places.err.equipment.csvFixedNeedsRoom", {
                  name: row.name ?? row.category,
                }),
              ],
            });
          }
          const room = await tx.room.findFirst({
            where: {
              OR: [{ slug: row.roomText }, { roomNumber: row.roomText }, { name: row.roomText }],
            },
            select: { id: true },
          });
          if (!room)
            throw new ValidationError({
              raum: [tr("places.err.room.csvRoomNotFound", { name: row.roomText })],
            });
          roomId = room.id;
        }

        const eq = await tx.equipment.create({
          data: {
            ...(await resolveEquipmentKind(tx, row)),
            modelId,
            roomId,
            mobility: row.mobility,
            status: row.status,
            name: row.name ?? null,
            assetTag: row.assetTag ?? null,
            serial: row.serial ?? null,
            hostname: row.hostname ?? null,
            ipAddress: row.ipAddress ?? null,
            macAddress: row.macAddress ?? null,
            frequencyMhz: row.frequencyMhz ?? null,
            band: row.band ?? null,
            channelLabel: row.channelLabel ?? null,
          },
        });
        await copyModelPortsInTx(tx, eq.id, eq.modelId);
        await audit({
          action: "EquipmentCreated",
          entityType: "equipment",
          entityId: eq.id,
          data: { name: eq.name, viaImport: true },
        });
        items.push({ id: eq.id, name: eq.name, category: eq.category, assetTag: eq.assetTag });
      }
      return { created: items.length, items };
    },
    // Dozens of sequential row round-trips in one tx can exceed Prisma's ~5s
    // default and abort with P2028 — give bulk imports generous headroom.
    { timeout: 30_000, maxWait: 10_000 },
  );
}
