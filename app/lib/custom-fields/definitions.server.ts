import { db, type Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { FieldNameConflictError, NotFoundError, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { tr } from "~/i18n/request-locale.server";
import { Prisma, type CustomFieldScope } from "~/generated/prisma/client";
import { createFieldSchema, updateFieldSchema, fieldOptionsSchema } from "./definitions.schema";
import type { z } from "zod";
import { convertRoomCustomValuesInTx } from "~/domains/rooms/rooms.custom-values.server";
import { convertEquipmentCustomValuesInTx } from "~/domains/inventory/inventory.custom-values.server";
import { convertModelCustomValuesInTx } from "~/domains/catalog/catalog.values.server";
import { applies, conditionHolds } from "./fields";
import { deriveFieldKey } from "./admin";
import { getFieldSchema } from "./schema.server";
import {
  propertiesForKind,
  isLibraryProperty,
  libraryProperties,
} from "~/lib/equipment-kinds/properties";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";
export { applies } from "./fields";

export const definitionInclude = {
  kinds: true,
  options: { orderBy: [{ position: "asc" }, { id: "asc" }] },
} satisfies Prisma.CustomFieldInclude;
export type FieldDefinition = Awaited<ReturnType<typeof getDefinitions>>[number];

export function getDefinitions(scope: CustomFieldScope, tx: Tx = db) {
  return tx.customField.findMany({
    where: { scope },
    include: definitionInclude,
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
}

export async function getRecordSchema(scope: CustomFieldScope, kindId?: string, deviceId?: string) {
  if (deviceId && scope !== "EQUIPMENT") fieldError("deviceId", tr("fields.error.applicable"));
  const device = deviceId
    ? await db.equipment.findUnique({
        where: { id: deviceId },
        include: { model: true },
      })
    : null;
  if (deviceId && !device) throw new NotFoundError();
  if (device)
    kindId =
      device.kindId ??
      (
        await db.equipmentKind.findUnique({
          where: { systemKey: DEFAULT_EQUIPMENT_KINDS[device.category].key },
        })
      )?.id;
  const fields = await getFieldSchema(scope);
  return fields
    .filter((field) => !field.hidden && applies(field, kindId))
    .map((field) => ({
      ...field,
      ...(device
        ? {
            conditionHolds: conditionHolds(
              field,
              fields,
              device.customValues,
              device.model?.customValues,
            ),
          }
        : {}),
    }));
}

export async function lockDefinitions(tx: Tx, write = false) {
  if (write) await tx.$executeRaw`SELECT pg_advisory_xact_lock(194031, 1)`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(194031, 1)`;
}

export function fieldError(key: string, message: string): never {
  throw new ValidationError({ [key]: [message] });
}

async function valuesExist(tx: Tx, fieldId: string, optionId?: string) {
  const match =
    optionId === undefined
      ? Prisma.sql`"customValues" ? ${fieldId}`
      : Prisma.sql`("customValues" -> ${fieldId}) @> ${JSON.stringify(optionId)}::jsonb`;
  const rows = await tx.$queryRaw<Array<{ present: boolean }>>(
    Prisma.sql`SELECT EXISTS(SELECT 1 FROM "Room" WHERE ${match} UNION ALL SELECT 1 FROM "Equipment" WHERE ${match} UNION ALL SELECT 1 FROM "EquipmentModel" WHERE ${match}) AS present`,
  );
  return rows[0].present;
}

async function checkLimits(tx: Tx, scope: CustomFieldScope) {
  const fields = (await getDefinitions(scope, tx)).filter((field) => !isLibraryProperty(field));
  if (fields.length > 120) fieldError("scope", tr("fields.limit.total"));
  const active = fields.filter((field) => !field.archivedAt);
  const kinds = new Set(active.flatMap((field) => field.kinds.map((link) => link.kindId)));
  if (
    [undefined, ...kinds].some(
      (kindId) => active.filter((field) => applies(field, kindId)).length > 40,
    )
  ) {
    fieldError("kindIds", tr("fields.limit.fields"));
  }
}

async function checkKinds(
  tx: Tx,
  scope: CustomFieldScope,
  kindIds: string[],
  retained: string[] = [],
) {
  if (scope === "ROOM" && kindIds.length) fieldError("kindIds", tr("fields.error.roomKinds"));
  if (
    new Set(kindIds).size !== kindIds.length ||
    (await tx.equipmentKind.count({
      where: { id: { in: kindIds }, OR: [{ archivedAt: null }, { id: { in: retained } }] },
    })) !== kindIds.length
  ) {
    fieldError("kindIds", tr("fields.error.kind"));
  }
}

async function checkFieldName(
  tx: Tx,
  scope: CustomFieldScope,
  name: string,
  kindIds: string[],
  excludeId?: string,
  libraryKey?: string | null,
) {
  if (scope === "EQUIPMENT") {
    const kinds = await tx.equipmentKind.findMany({
      where: kindIds.length ? { id: { in: kindIds } } : {},
    });
    if (
      kinds.some((kind) =>
        propertiesForKind(kind.systemKey, true).some(
          (property) =>
            property.key !== libraryKey &&
            [property.de, property.en].some((label) => label.toLowerCase() === name.toLowerCase()),
        ),
      )
    )
      fieldError("name", tr("fields.library.nameTaken"));
  }
  const matches = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "CustomField"
    WHERE scope = ${scope}::"CustomFieldScope" AND lower(name) = lower(${name})
    ORDER BY id`;
  const fields = await tx.customField.findMany({
    where: { id: { in: matches.map((row) => row.id).filter((id) => id !== excludeId) } },
    include: { kinds: { include: { kind: true } } },
    orderBy: { id: "asc" },
  });
  const holder = fields.find(
    (field) =>
      scope === "ROOM" ||
      !kindIds.length ||
      !field.kinds.length ||
      field.kinds.some((link) => kindIds.includes(link.kindId)),
  );
  if (!holder) return;
  const coverage =
    scope === "ROOM"
      ? tr("fields.name.allRooms")
      : !holder.kinds.length
        ? tr("fields.name.allKinds")
        : holder.kinds
            .map((link) => link.kind.name)
            .sort()
            .join(", ");
  throw new FieldNameConflictError(
    holder.id,
    tr("fields.name.conflict", {
      name: holder.name,
      coverage,
      state: tr(holder.archivedAt ? "fields.name.archived" : "fields.name.active"),
    }),
  );
}

async function publish<T extends { id: string }>(result: T, op: "created" | "updated" | "deleted") {
  await emitChange({ entityType: "customField", id: result.id, op });
  return result;
}

export async function moveKindFieldsInTx(
  tx: Tx,
  audit: AuditFn,
  current: { id: string; name: string },
  target: { id: string; name: string },
) {
  const id = current.id;
  const movedFields: string[] = [];
  const fields = await getDefinitions("EQUIPMENT", tx);
  const moving = fields.filter(
    (field) => !isLibraryProperty(field) && field.kinds.some((link) => link.kindId === id),
  );
  const active = fields.filter(
    (field) =>
      !isLibraryProperty(field) &&
      !field.archivedAt &&
      (applies(field, target.id) || moving.includes(field)),
  );
  if (active.length > 40)
    throw new ValidationError({
      moveDevicesTo: [
        tr("admin.structure.fieldMoveLimit", {
          names: active.map((field) => field.name).join(", "),
          target: target.name,
        }),
      ],
    });
  for (const field of moving) {
    if (field.kinds.some((link) => link.kindId === target.id)) continue;
    const kindIds = [...field.kinds.map((link) => link.kindId), target.id];
    try {
      await checkFieldName(tx, "EQUIPMENT", field.name, kindIds, field.id);
    } catch (error) {
      if (error instanceof FieldNameConflictError)
        throw new ValidationError({
          moveDevicesTo: [
            tr("admin.structure.fieldMoveName", {
              name: field.name,
              source: current.name,
              target: target.name,
            }),
          ],
        });
      throw error;
    }
    await tx.customFieldKind.create({ data: { fieldId: field.id, kindId: target.id } });
    await tx.customField.update({ where: { id: field.id }, data: { updatedAt: new Date() } });
    movedFields.push(field.id);
    await audit({
      action: "CustomFieldUpdated",
      entityType: "customField",
      entityId: field.id,
      data: {
        name: field.name,
        before: field.kinds.map((link) => link.kindId),
        after: kindIds,
      },
    });
  }
  return movedFields;
}

export async function createCustomField(
  actor: AuditActor,
  input: Omit<z.input<typeof createFieldSchema>, "type"> & { type: FieldDefinition["type"] },
) {
  return createField(actor, createFieldSchema.parse(input));
}

export async function createNamedCustomField(
  actor: AuditActor,
  input: Omit<z.input<typeof createFieldSchema>, "key">,
) {
  return createField(actor, createFieldSchema.parse({ ...input, key: "field" }), true);
}

async function createField(
  actor: AuditActor,
  data: z.output<typeof createFieldSchema>,
  deriveKey = false,
) {
  const result = await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx, true);
    const { kindIds, ...columns } = data;
    if (deriveKey)
      columns.key = deriveFieldKey(
        columns.name,
        (
          await tx.customField.findMany({ where: { scope: data.scope }, select: { key: true } })
        ).map((field) => field.key),
      );
    await checkKinds(tx, data.scope, kindIds);
    await checkFieldName(tx, data.scope, data.name, kindIds);
    if (data.unit != null && data.type !== "NUMBER") fieldError("unit", tr("fields.error.unit"));
    const field = await tx.customField.create({
      data: { ...columns, kinds: { create: kindIds.map((kindId) => ({ kindId })) } },
      include: definitionInclude,
    });
    await checkLimits(tx, field.scope);
    await audit({
      action: "CustomFieldCreated",
      entityType: "customField",
      entityId: field.id,
      data: { key: field.key, name: field.name, type: field.type, kindIds },
    });
    return field;
  });
  return publish(result, "created");
}

export async function updateCustomField(
  actor: AuditActor,
  input: z.input<typeof updateFieldSchema>,
) {
  const { id, archived, kindIds, resetName, ...columns } = updateFieldSchema.parse(input);
  const result = await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx, true);
    const before = await tx.customField.findUnique({ where: { id }, include: definitionInclude });
    if (!before) throw new NotFoundError();
    if (
      isLibraryProperty(before) &&
      (kindIds !== undefined ||
        Object.keys(columns).some(
          (key) => !["name", "position", "showInList", "listPosition", "searchable"].includes(key),
        ))
    )
      fieldError("id", tr("fields.library.protected"));
    if (resetName && (!isLibraryProperty(before) || columns.name !== undefined))
      fieldError("resetName", tr("fields.library.protected"));
    if (resetName) columns.name = libraryProperties.get(before.systemKey!)!.de;
    if (kindIds)
      await checkKinds(
        tx,
        before.scope,
        kindIds,
        before.kinds.map((link) => link.kindId),
      );
    if (columns.name !== undefined || kindIds !== undefined)
      await checkFieldName(
        tx,
        before.scope,
        columns.name ?? before.name,
        kindIds ?? before.kinds.map((link) => link.kindId),
        id,
        before.systemKey,
      );
    let convertedRecords = 0;
    if (columns.type && columns.type !== before.type) {
      const pair = `${before.type}:${columns.type}`;
      if (!["TEXT:LONG_TEXT", "CHOICE:MULTI_CHOICE", "MULTI_CHOICE:CHOICE"].includes(pair))
        fieldError("type", tr("fields.error.type"));
      if (before.type === "MULTI_CHOICE") {
        const table =
          before.scope === "ROOM"
            ? Prisma.sql`"Room"`
            : before.level === "MODEL"
              ? Prisma.sql`"EquipmentModel"`
              : Prisma.sql`"Equipment"`;
        const counts = await tx.$queryRaw<Array<{ count: bigint }>>(
          Prisma.sql`SELECT count(*) FROM ${table} WHERE CASE WHEN jsonb_typeof("customValues" -> ${id}) = 'array' THEN jsonb_array_length("customValues" -> ${id}) ELSE 0 END > 1`,
        );
        if (counts[0].count > 0)
          fieldError("type", tr("fields.error.multiple", { count: Number(counts[0].count) }));
      }
      if (before.type === "CHOICE") {
        const table =
          before.scope === "ROOM"
            ? Prisma.sql`"Room"`
            : before.level === "MODEL"
              ? Prisma.sql`"EquipmentModel"`
              : Prisma.sql`"Equipment"`;
        const rows = await tx.$queryRaw<Array<{ present: boolean }>>(
          Prisma.sql`SELECT EXISTS(SELECT 1 FROM ${table} WHERE "customValues" ? ${id} AND pg_column_size(jsonb_set("customValues", ARRAY[${id}], jsonb_build_array("customValues" -> ${id}))) > 32768) AS present`,
        );
        if (rows[0].present) fieldError("type", tr("fields.limit.bytes"));
      }
      if (before.type === "CHOICE" || before.type === "MULTI_CHOICE")
        convertedRecords = await (
          before.scope === "ROOM"
            ? convertRoomCustomValuesInTx
            : before.level === "MODEL"
              ? convertModelCustomValuesInTx
              : convertEquipmentCustomValuesInTx
        )(tx, id, columns.type === "MULTI_CHOICE");
    }
    if (columns.unit != null && (columns.type ?? before.type) !== "NUMBER")
      fieldError("unit", tr("fields.error.unit"));
    const field = await tx.customField.update({
      where: { id },
      data: {
        ...columns,
        ...(isLibraryProperty(before) && (columns.name !== undefined || resetName)
          ? {
              renamed:
                !resetName &&
                ![
                  libraryProperties.get(before.systemKey!)!.de,
                  libraryProperties.get(before.systemKey!)!.en,
                ].includes(columns.name!),
            }
          : {}),
        ...(archived !== undefined && Boolean(before.archivedAt) !== archived
          ? { archivedAt: archived ? new Date() : null }
          : {}),
        ...(kindIds
          ? { kinds: { deleteMany: {}, create: kindIds.map((kindId) => ({ kindId })) } }
          : {}),
      },
      include: definitionInclude,
    });
    await checkLimits(tx, field.scope);
    const action =
      archived === undefined || Boolean(before.archivedAt) === archived
        ? "CustomFieldUpdated"
        : archived
          ? "CustomFieldArchived"
          : "CustomFieldRestored";
    await audit({
      action,
      entityType: "customField",
      entityId: id,
      data: JSON.parse(
        JSON.stringify({ before, after: field, convertedRecords }),
      ) as Prisma.InputJsonValue,
    });
    return field;
  });
  return publish(result, "updated");
}

export async function updateFieldOptions(
  actor: AuditActor,
  input: z.input<typeof fieldOptionsSchema>,
  append = false,
) {
  const { fieldId, changes } = fieldOptionsSchema.parse(input);
  const result = await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx, true);
    const field = await tx.customField.findUnique({ where: { id: fieldId } });
    if (!field) throw new NotFoundError();
    if (isLibraryProperty(field)) fieldError("fieldId", tr("fields.library.protected"));
    if (field.type !== "CHOICE" && field.type !== "MULTI_CHOICE")
      fieldError("fieldId", tr("fields.error.choice"));
    const max = await tx.customFieldOption.aggregate({
      where: { fieldId },
      _max: { position: true },
    });
    let nextPosition = (max._max.position ?? -1) + 1;
    for (const change of changes) {
      if (change.op === "add") {
        await tx.customFieldOption.create({
          data: {
            fieldId,
            label: change.label,
            position: append ? nextPosition++ : change.position,
          },
        });
      } else {
        const option = await tx.customFieldOption.findFirst({ where: { id: change.id, fieldId } });
        if (!option) throw new NotFoundError();
        if (change.op === "delete") {
          if (await valuesExist(tx, fieldId, change.id))
            fieldError("changes", tr("fields.error.optionInUse"));
          await tx.customFieldOption.delete({ where: { id: change.id } });
        } else
          await tx.customFieldOption.update({
            where: { id: change.id },
            data: {
              label: change.label,
              position: change.position,
              ...(change.archived !== undefined
                ? { archivedAt: change.archived ? new Date() : null }
                : {}),
            },
          });
      }
    }
    const options = await tx.customFieldOption.findMany({ where: { fieldId } });
    if (options.filter((option) => !option.archivedAt).length > 50)
      fieldError("changes", tr("fields.limit.options"));
    if (options.length > 200) fieldError("changes", tr("fields.limit.totalOptions"));
    const updated = await tx.customField.update({
      where: { id: fieldId },
      data: { updatedAt: new Date() },
      include: definitionInclude,
    });
    await audit({
      action: "CustomFieldOptionsChanged",
      entityType: "customField",
      entityId: fieldId,
      data: { changes },
    });
    return updated;
  });
  return publish(result, "updated");
}

export async function deleteCustomField(actor: AuditActor, id: string, archivedOnly = false) {
  const result = await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx, true);
    const before = await tx.customField.findUniqueOrThrow({ where: { id } });
    if (isLibraryProperty(before)) fieldError("id", tr("fields.library.protected"));
    if (archivedOnly && !before.archivedAt) fieldError("id", tr("fields.admin.archiveFirst"));
    const counts = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) FROM (
        SELECT id FROM "Room" WHERE "customValues" ? ${id}
        UNION ALL SELECT id FROM "Equipment" WHERE "customValues" ? ${id}
        UNION ALL SELECT id FROM "EquipmentModel" WHERE "customValues" ? ${id}
      ) records`;
    if (counts[0].count)
      fieldError(
        "id",
        tr(counts[0].count === 1n ? "fields.error.inUseOne" : "fields.error.inUse", {
          count: Number(counts[0].count),
        }),
      );
    const field = await tx.customField.delete({ where: { id }, include: definitionInclude });
    await audit({
      action: "CustomFieldDeleted",
      entityType: "customField",
      entityId: id,
      data: JSON.parse(JSON.stringify(field)) as Prisma.InputJsonValue,
    });
    return { id };
  });
  return publish(result, "deleted");
}
