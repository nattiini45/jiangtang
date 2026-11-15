import { z } from "zod";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { requirePermission } from "~/lib/rbac.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { lockDefinitions } from "~/lib/custom-fields/definitions.server";
import { propertyLibrary } from "~/lib/equipment-kinds/properties";

export async function setModelPartFit(actor: AuditActor, modelId: string, input: unknown) {
  const data = z
    .object({ partModelId: z.string().min(1), remove: z.boolean().default(false) })
    .parse(input);
  await txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "equipment.edit", tx);
    await lockDefinitions(tx);
    await tx.$queryRaw`SELECT id FROM "EquipmentModel" WHERE id = ${modelId} FOR UPDATE`;
    const host = await tx.equipmentModel.findUnique({ where: { id: modelId } });
    const part = await tx.equipmentModel.findUnique({
      where: { id: data.partModelId },
      include: { kind: { include: { group: true } } },
    });
    if (!host || !part) throw new NotFoundError();
    if (
      part.id === host.id ||
      !part.kind ||
      part.kind.archivedAt ||
      part.kind.group.archivedAt ||
      (part.kind.systemKey && !propertyLibrary.partKinds?.includes(part.kind.systemKey))
    )
      throw new ValidationError({}, [tr("parts.invalidFit")]);
    const existing = await tx.modelPartFit.findUnique({
      where: { modelId_partModelId: { modelId, partModelId: part.id } },
    });
    if (data.remove && existing?.catalogKey)
      throw new ValidationError({}, [tr("parts.catalogFit")]);
    if (data.remove ? !existing : existing) return;
    if (data.remove) await tx.modelPartFit.delete({ where: { id: existing!.id } });
    else await tx.modelPartFit.create({ data: { modelId, partModelId: part.id } });
    await audit({
      action: data.remove ? "ModelPartFitRemoved" : "ModelPartFitAdded",
      entityType: "equipmentModel",
      entityId: modelId,
      data: { partModelId: part.id, partNumber: part.name },
    });
  });
  await emitChange({ entityType: "equipmentModel", id: modelId, op: "updated" });
}
