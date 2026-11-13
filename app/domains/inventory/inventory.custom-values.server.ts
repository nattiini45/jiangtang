import type { Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { emitChange } from "~/lib/realtime/emit.server";
import {
  prepareCustomValues,
  validateCustomValues,
  CustomValuesError,
} from "~/lib/custom-fields/values.server";
import type { CustomValuesInput } from "~/lib/custom-fields/values.schema";
import { getFieldSchema, type ResolvedField } from "~/lib/custom-fields/schema.server";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";
import { sameValue, valueObject } from "~/lib/custom-fields/fields";
import {
  legacyColumnValues,
  legacyPropertyValues,
  legacyProperties,
  unmigratedLegacyValues,
} from "~/lib/custom-fields/legacy.server";
import { ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { lockDefinitions } from "~/lib/custom-fields/definitions.server";

export async function clearLegacyEquipmentValue(actor: AuditActor, id: string, column: string) {
  await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx);
    await tx.$queryRaw`SELECT id FROM "Equipment" WHERE id = ${id} FOR UPDATE`;
    const device = await tx.equipment.findUniqueOrThrow({
      where: { id },
      include: { model: { select: { customValues: true } } },
    });
    const kindId =
      device.kindId ??
      (
        await tx.equipmentKind.findUnique({
          where: { systemKey: DEFAULT_EQUIPMENT_KINDS[device.category].key },
        })
      )?.id;
    const retained = unmigratedLegacyValues(
      await getFieldSchema("EQUIPMENT", {}, tx),
      device,
      kindId!,
    );
    const field = retained.find((field) => field.legacyColumn === column);
    if (!field) throw new ValidationError({ legacy: [tr("fields.error.value")] });
    await tx.equipment.update({ where: { id }, data: { [column]: null } });
    await audit({
      action: "EquipmentUpdated",
      entityType: "equipment",
      entityId: id,
      data: {
        clearedLegacyColumn: column,
        custom: [{ name: field.name, from: field.value, to: null }],
      },
    });
  });
  await emitChange({ entityType: "equipment", id, op: "updated" });
}

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
  deviceFallbackIds: readonly string[] = [],
) {
  const patch = await prepareCustomValues(
    tx,
    "EQUIPMENT",
    id,
    values,
    kindId,
    modelId,
    deviceFallbackIds,
  );
  await tx.$executeRaw`UPDATE "Equipment" SET "customValues" = ("customValues" || ${JSON.stringify(patch.set)}::jsonb) - ${patch.removed}::text[], "updatedAt" = now() WHERE id = ${id}`;
  const columns = legacyColumnValues(await getFieldSchema("EQUIPMENT", {}, tx), {
    ...patch.set,
    ...Object.fromEntries(patch.removed.map((id) => [id, null])),
  });
  if (Object.keys(columns).length) await tx.equipment.update({ where: { id }, data: columns });
  return patch.auditData;
}

export async function applyEquipmentPropertiesInTx(
  tx: Tx,
  id: string,
  input: Partial<Record<keyof typeof legacyProperties, unknown>> & {
    customValues?: CustomValuesInput;
  },
  kindId?: string | null,
  modelId?: string | null,
) {
  const row = await tx.equipment.findUniqueOrThrow({ where: { id } });
  const fields = await getFieldSchema("EQUIPMENT", {}, tx);
  const legacy = legacyPropertyValues(fields, kindId ?? row.kindId, input);
  for (const field of fields) {
    if (
      Object.hasOwn(input.customValues ?? {}, field.key) ||
      (field.libraryKey && Object.hasOwn(input.customValues ?? {}, field.libraryKey)) ||
      sameValue(legacy[field.key], valueObject(row.customValues)[field.id])
    )
      delete legacy[field.key];
  }
  const values = { ...legacy, ...input.customValues };
  const fallbackIds = fields
    .filter((field) => field.libraryKey === "microphone.type" && Object.hasOwn(legacy, field.key))
    .map((field) => field.id);
  return Object.keys(values).length
    ? applyEquipmentCustomValuesInTx(tx, id, values, kindId, modelId, fallbackIds)
    : undefined;
}

export async function copyLegacyEquipmentPropertiesInTx(
  tx: Tx,
  audit: AuditFn,
  definitions: ResolvedField[],
  version: number,
) {
  const fields = definitions.map((field) => ({ ...field, archivedAt: null }));
  const kinds = await tx.equipmentKind.findMany({ where: { systemKey: { not: null } } });
  const devices = await tx.equipment.findMany({
    where: {
      OR: [
        { micKind: { not: null } },
        { frequencyMhz: { not: null } },
        { band: { not: null } },
        { channelLabel: { not: null } },
        { lastLampChangeAt: { not: null } },
        { color: { not: null } },
        { dellServiceTag: { not: null } },
      ],
    },
  });
  const copied: string[] = [];
  for (const device of devices) {
    const kindId =
      device.kindId ??
      kinds.find((kind) => kind.systemKey === DEFAULT_EQUIPMENT_KINDS[device.category].key)?.id ??
      null;
    let values = legacyPropertyValues(fields, kindId, device, device.customValues);
    if (!Object.keys(values).length) continue;
    let patch;
    try {
      patch = validateCustomValues(fields, values, kindId);
    } catch (error) {
      if (!(error instanceof CustomValuesError)) throw error;
      const invalid = new Set(error.errors.map((error) => error.field));
      console.warn("[equipment-properties] legacy values left in their columns", {
        deviceId: device.id,
        fields: [...invalid],
      });
      values = Object.fromEntries(Object.entries(values).filter(([key]) => !invalid.has(key)));
      if (!Object.keys(values).length) continue;
      patch = validateCustomValues(fields, values, kindId);
    }
    await tx.equipment.update({
      where: { id: device.id },
      data: { customValues: { ...(device.customValues as object), ...patch.set } },
    });
    await audit({
      action: "LibraryDevicePropertiesCopied",
      entityType: "equipment",
      entityId: device.id,
      data: { count: Object.keys(patch.set).length, version },
    });
    copied.push(device.id);
  }
  return copied;
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
