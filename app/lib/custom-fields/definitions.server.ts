import { db, type Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { tr } from "~/i18n/request-locale.server";
import type { CustomFieldScope, Prisma } from "~/generated/prisma/client";
import { createFieldSchema, updateFieldSchema, fieldOptionsSchema } from "./definitions.schema";
import type { z } from "zod";

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

export function applies(field: { kinds: { kindId: string }[] }, kindId?: string | null) {
  return field.kinds.length === 0 || field.kinds.some((link) => link.kindId === kindId);
}

export async function getRecordSchema(scope: CustomFieldScope, kindId?: string) {
  return (await getDefinitions(scope)).filter(
    (field) => !field.archivedAt && applies(field, kindId),
  );
}

export async function lockDefinitions(tx: Tx, write = false) {
  if (write) await tx.$executeRaw`SELECT pg_advisory_xact_lock(194031, 1)`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(194031, 1)`;
}

export function fieldError(key: string, message: string): never {
  throw new ValidationError({ [key]: [message] });
}

async function checkLimits(tx: Tx, scope: CustomFieldScope) {
  const fields = await getDefinitions(scope, tx);
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

async function checkKinds(tx: Tx, scope: CustomFieldScope, kindIds: string[]) {
  if (scope === "ROOM" && kindIds.length) fieldError("kindIds", tr("fields.error.roomKinds"));
  if (
    new Set(kindIds).size !== kindIds.length ||
    (await tx.equipmentKind.count({ where: { id: { in: kindIds }, archivedAt: null } })) !==
      kindIds.length
  ) {
    fieldError("kindIds", tr("fields.error.kind"));
  }
}

async function publish<T extends { id: string }>(result: T, op: "created" | "updated" | "deleted") {
  await emitChange({ entityType: "customField", id: result.id, op });
  return result;
}

export async function createCustomField(
  actor: AuditActor,
  input: z.input<typeof createFieldSchema>,
) {
  const data = createFieldSchema.parse(input);
  const result = await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx, true);
    const { kindIds, ...columns } = data;
    await checkKinds(tx, data.scope, kindIds);
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
  const { id, archived, kindIds, ...columns } = updateFieldSchema.parse(input);
  const result = await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx, true);
    const before = await tx.customField.findUnique({ where: { id }, include: definitionInclude });
    if (!before) throw new NotFoundError();
    if (kindIds) await checkKinds(tx, before.scope, kindIds);
    if (columns.unit != null && before.type !== "NUMBER")
      fieldError("unit", tr("fields.error.unit"));
    const field = await tx.customField.update({
      where: { id },
      data: {
        ...columns,
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
      data: JSON.parse(JSON.stringify({ before, after: field })) as Prisma.InputJsonValue,
    });
    return field;
  });
  return publish(result, "updated");
}

export async function updateFieldOptions(
  actor: AuditActor,
  input: z.input<typeof fieldOptionsSchema>,
) {
  const { fieldId, changes } = fieldOptionsSchema.parse(input);
  const result = await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx, true);
    const field = await tx.customField.findUnique({ where: { id: fieldId } });
    if (!field) throw new NotFoundError();
    if (field.type !== "CHOICE" && field.type !== "MULTI_CHOICE")
      fieldError("fieldId", tr("fields.error.choice"));
    for (const change of changes) {
      if (change.op === "add") {
        await tx.customFieldOption.create({
          data: { fieldId, label: change.label, position: change.position },
        });
      } else {
        const option = await tx.customFieldOption.findFirst({ where: { id: change.id, fieldId } });
        if (!option) throw new NotFoundError();
        if (change.op === "delete") await tx.customFieldOption.delete({ where: { id: change.id } });
        else
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

export async function deleteCustomField(actor: AuditActor, id: string) {
  const result = await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx, true);
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
