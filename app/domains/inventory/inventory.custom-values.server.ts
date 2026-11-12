import type { Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { prepareCustomValues } from "~/lib/custom-fields/values.server";
import type { CustomValuesInput } from "~/lib/custom-fields/values.schema";

export async function convertEquipmentCustomValuesInTx(tx: Tx, fieldId: string, multiple: boolean) {
  return tx.$executeRaw`UPDATE "Equipment" SET "customValues" = CASE
    WHEN ${multiple} THEN jsonb_set("customValues", ARRAY[${fieldId}], jsonb_build_array("customValues" -> ${fieldId}))
    WHEN jsonb_array_length("customValues" -> ${fieldId}) = 0 THEN "customValues" - ${fieldId}
    ELSE jsonb_set("customValues", ARRAY[${fieldId}], ("customValues" -> ${fieldId}) -> 0) END
    WHERE "customValues" ? ${fieldId} AND jsonb_typeof("customValues" -> ${fieldId}) = ${multiple ? "string" : "array"}`;
}

export async function applyEquipmentCustomValuesInTx(
  tx: Tx,
  id: string,
  values: CustomValuesInput,
  kindId?: string | null,
  modelId?: string | null,
) {
  const patch = await prepareCustomValues(tx, "EQUIPMENT", id, values, kindId, modelId);
  await tx.$executeRaw`UPDATE "Equipment" SET "customValues" = ("customValues" || ${JSON.stringify(patch.set)}::jsonb) - ${patch.removed}::text[], "updatedAt" = now() WHERE id = ${id}`;
  return patch.auditData;
}

export async function setEquipmentCustomValues(
  actor: AuditActor,
  id: string,
  values: CustomValuesInput,
) {
  const result = await txWithAudit(actor, async (tx, audit) => {
    const data = await applyEquipmentCustomValuesInTx(tx, id, values);
    await audit({ action: "EquipmentUpdated", entityType: "equipment", entityId: id, data });
    return tx.equipment.findUniqueOrThrow({ where: { id } });
  });
  await emitChange({ entityType: "equipment", id, op: "updated" });
  return result;
}
