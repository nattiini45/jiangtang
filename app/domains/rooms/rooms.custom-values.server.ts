import type { Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { prepareCustomValues } from "~/lib/custom-fields/values.server";
import type { CustomValuesInput } from "~/lib/custom-fields/values.schema";

export async function convertRoomCustomValuesInTx(tx: Tx, fieldId: string, multiple: boolean) {
  return tx.$executeRaw`UPDATE "Room" SET "customValues" = CASE
    WHEN ${multiple} THEN jsonb_set("customValues", ARRAY[${fieldId}], jsonb_build_array("customValues" -> ${fieldId}))
    WHEN jsonb_array_length("customValues" -> ${fieldId}) = 0 THEN "customValues" - ${fieldId}
    ELSE jsonb_set("customValues", ARRAY[${fieldId}], ("customValues" -> ${fieldId}) -> 0) END
    WHERE "customValues" ? ${fieldId} AND jsonb_typeof("customValues" -> ${fieldId}) = ${multiple ? "string" : "array"}`;
}

export async function applyRoomCustomValuesInTx(tx: Tx, id: string, values: CustomValuesInput) {
  const patch = await prepareCustomValues(tx, "ROOM", id, values);
  await tx.$executeRaw`UPDATE "Room" SET "customValues" = ("customValues" || ${JSON.stringify(patch.set)}::jsonb) - ${patch.removed}::text[], "updatedAt" = now() WHERE id = ${id}`;
  return patch.auditData;
}

export async function setRoomCustomValues(
  actor: AuditActor,
  id: string,
  values: CustomValuesInput,
) {
  const result = await txWithAudit(actor, async (tx, audit) => {
    const data = await applyRoomCustomValuesInTx(tx, id, values);
    await audit({ action: "RoomUpdated", entityType: "room", entityId: id, data });
    return tx.room.findUniqueOrThrow({ where: { id } });
  });
  await emitChange({ entityType: "room", id, op: "updated" });
  return result;
}
