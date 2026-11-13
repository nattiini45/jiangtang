import { Prisma } from "~/generated/prisma/client";
import type { Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { lockDefinitions } from "~/lib/custom-fields/definitions.server";
import { getFieldSchema } from "~/lib/custom-fields/schema.server";
import {
  validateCustomValues,
  validateConditions,
  customValueChanges,
} from "~/lib/custom-fields/values.server";
import { valueObject } from "~/lib/custom-fields/fields";
import { emitChange } from "~/lib/realtime/emit.server";
import { ValidationError, NotFoundError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";

export async function convertModelCustomValuesInTx(tx: Tx, fieldId: string, multiple: boolean) {
  return tx.$executeRaw`UPDATE "EquipmentModel" SET "customValues" = CASE
    WHEN ${multiple} THEN jsonb_set("customValues", ARRAY[${fieldId}], jsonb_build_array("customValues" -> ${fieldId}))
    WHEN jsonb_array_length("customValues" -> ${fieldId}) = 0 THEN "customValues" - ${fieldId}
    ELSE jsonb_set("customValues", ARRAY[${fieldId}], ("customValues" -> ${fieldId}) -> 0) END
    WHERE "customValues" ? ${fieldId} AND jsonb_typeof("customValues" -> ${fieldId}) = ${multiple ? "string" : "array"}`;
}

export async function applyModelValuesInTx(
  tx: Tx,
  modelId: string,
  values: Record<string, unknown>,
) {
  await lockDefinitions(tx);
  const rows = await tx.$queryRaw<
    { customValues: Prisma.JsonObject }[]
  >`SELECT "customValues" FROM "EquipmentModel" WHERE id = ${modelId} FOR UPDATE`;
  if (!rows[0]) throw new NotFoundError();
  const model = await tx.equipmentModel.findUniqueOrThrow({ where: { id: modelId } });
  const kindId =
    model.kindId ??
    (
      await tx.equipmentKind.findUnique({
        where: { systemKey: DEFAULT_EQUIPMENT_KINDS[model.category].key },
      })
    )?.id;
  const fields = (await getFieldSchema("EQUIPMENT", {}, tx)).filter(
    (field) => field.level === "MODEL",
  );
  const patch = validateCustomValues(fields, values, kindId);
  const before = valueObject(rows[0]?.customValues);
  validateConditions(fields, patch, before);
  const after = { ...before, ...patch.set };
  for (const id of patch.removed) delete after[id];
  const sizes = await tx.$queryRaw<
    { bytes: number }[]
  >`SELECT pg_column_size(${JSON.stringify(after)}::jsonb) AS bytes`;
  if (sizes[0].bytes > 32768)
    throw new ValidationError({ customValues: [tr("fields.limit.bytes")] });
  await tx.equipmentModel.update({
    where: { id: modelId },
    data: { customValues: after as Prisma.InputJsonObject },
  });
  return customValueChanges(fields, rows[0].customValues, patch);
}

export async function setModelValues(
  actor: AuditActor,
  modelId: string,
  values: Record<string, unknown>,
) {
  const model = await txWithAudit(actor, async (tx, audit) => {
    const data = await applyModelValuesInTx(tx, modelId, values);
    await audit({
      action: "EquipmentModelUpdated",
      entityType: "equipmentModel",
      entityId: modelId,
      data: data as Prisma.InputJsonObject,
    });
    return tx.equipmentModel.findUniqueOrThrow({ where: { id: modelId } });
  });
  await emitChange({ entityType: "equipmentModel", id: modelId, op: "updated" });
  return model;
}
