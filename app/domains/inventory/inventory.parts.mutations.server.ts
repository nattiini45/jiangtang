import { z } from "zod";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { requirePermission } from "~/lib/rbac.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { lockDefinitions } from "~/lib/custom-fields/definitions.server";
import { requirePartModel } from "~/domains/catalog/catalog.queries.server";
import { createStockInTx } from "./inventory.stock.mutations.server";
import { availablePartStock } from "./inventory.parts.queries.server";
import { getFieldSchema } from "~/lib/custom-fields/schema.server";
import { readingRules } from "~/domains/readings/readings.policy";
import { appendReadingInTx } from "~/domains/readings/readings.mutations.server";

export async function addPartStock(actor: AuditActor, modelId: string, quantity: unknown) {
  const count = z.coerce.number().int().min(1).max(2147483647).parse(quantity);
  const item = await txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "equipment.edit", tx);
    await lockDefinitions(tx);
    const model = await requirePartModel(modelId, tx);
    const item = await createStockInTx(
      tx,
      { name: model.name, quantity: count, status: "AVAILABLE", tags: [] },
      actor.id,
      modelId,
    );
    await audit({
      action: "InventoryItemCreated",
      entityType: "inventory-item",
      entityId: item.id,
      data: { name: item.name, quantity: item.quantity, modelId },
    });
    return item;
  });
  await emitChange({ entityType: "inventory-item", id: item.id, op: "created" });
  await emitChange({ entityType: "equipmentModel", id: modelId, op: "updated" });
  return item;
}

export async function linkStockModel(actor: AuditActor, stockId: string, modelId: string | null) {
  await txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "equipment.edit", tx);
    await lockDefinitions(tx);
    await tx.$queryRaw`SELECT id FROM "InventoryItem" WHERE id = ${stockId} FOR UPDATE`;
    const stock = await tx.inventoryItem.findUnique({ where: { id: stockId } });
    if (!stock) throw new NotFoundError();
    if (stock.modelId === modelId) return;
    if (modelId) await requirePartModel(modelId, tx);
    await tx.inventoryItem.update({ where: { id: stockId }, data: { modelId } });
    await audit({
      action: "StockModelLinked",
      entityType: "inventory-item",
      entityId: stockId,
      data: { from: stock.modelId, to: modelId },
    });
  });
  await emitChange({ entityType: "inventory-item", id: stockId, op: "updated" });
}

export async function takePartForDevice(
  actor: AuditActor,
  equipmentId: string,
  stockId: string,
  replace = false,
) {
  const result = await txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "equipment.edit", tx);
    await lockDefinitions(tx);
    await tx.$queryRaw`SELECT id FROM "Equipment" WHERE id = ${equipmentId} FOR UPDATE`;
    const device = await tx.equipment.findUnique({ where: { id: equipmentId } });
    const stock = await tx.inventoryItem.findUnique({ where: { id: stockId } });
    if (!device || !stock) throw new NotFoundError();
    if (!device.modelId || !stock.modelId || device.status === "RETIRED")
      throw new ValidationError({}, [tr("parts.invalidFit")]);
    const fits = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "ModelPartFit"
      WHERE "modelId" = ${device.modelId} AND "partModelId" = ${stock.modelId} FOR SHARE`;
    if (!fits.length) throw new ValidationError({}, [tr("parts.invalidFit")]);
    const changed = await tx.inventoryItem.updateMany({
      where: { id: stock.id, modelId: stock.modelId, ...availablePartStock },
      data: { quantity: { decrement: 1 } },
    });
    if (!changed.count) throw new ValidationError({}, [tr("parts.unavailable")]);
    const after = await tx.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } });
    const part = await requirePartModel(stock.modelId, tx);
    const measures = replace
      ? await getFieldSchema("EQUIPMENT", { store: "READING", kindId: device.kindId }, tx)
      : [];
    for (const field of measures) {
      if (!readingRules[field.libraryKey ?? ""]?.partKinds?.includes(part.kind?.systemKey ?? ""))
        continue;
      await appendReadingInTx(tx, audit, actor, {
        equipmentId,
        fieldId: field.id,
        value: 0,
        observedAt: new Date(),
        source: "replacement",
        sourceRef: stockId,
        partModelId: part.id,
      });
    }
    const data = {
      stockId,
      equipmentId,
      modelId: device.modelId,
      partModelId: part.id,
      partNumber: part.name,
      ...(replace ? { replaced: true } : {}),
      quantity: 1,
      from: after.quantity + 1,
      to: after.quantity,
    };
    await audit({
      action: "PartTakenForDevice",
      entityType: "inventory-item",
      entityId: stock.id,
      data,
    });
    await audit({
      action: "PartTakenForDevice",
      entityType: "equipment",
      entityId: device.id,
      data,
    });
    return { stockId, partModelId: part.id, hostModelId: device.modelId };
  });
  await emitChange({ entityType: "inventory-item", id: stockId, op: "updated" });
  await emitChange({ entityType: "equipment", id: equipmentId, op: "updated" });
  for (const id of [result.partModelId, result.hostModelId])
    await emitChange({ entityType: "equipmentModel", id, op: "updated" });
}
