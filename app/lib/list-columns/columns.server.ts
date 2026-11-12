import { db } from "~/lib/db.server";
import { Prisma } from "~/generated/prisma/client";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { getDefinitions, lockDefinitions } from "~/lib/custom-fields/definitions.server";
import { applies, valueObject } from "~/lib/custom-fields/fields";
import { emitChange } from "~/lib/realtime/emit.server";
import { ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import {
  DEFAULT_COLUMNS,
  fieldColumnId,
  resolveColumns,
  type ListColumns,
  type ListScope,
  type ListValue,
} from "./columns";

export async function getListColumns(scope: ListScope, admin: boolean): Promise<ListColumns> {
  const [stored, definitions, kinds] = await Promise.all([
    db.listColumns.findUnique({ where: { scope } }),
    getDefinitions(scope),
    scope === "EQUIPMENT" ? db.equipmentKind.findMany({ select: { id: true, name: true } }) : [],
  ]);
  const active = definitions.filter((field) => !field.archivedAt);
  const columns = resolveColumns(scope, stored?.columns, active);
  return {
    columns,
    fields: active
      .filter((field) => admin || columns.includes(fieldColumnId(field.id)))
      .map((field) => ({
        id: field.id,
        name: field.name,
        type: field.type,
        unit: field.unit,
        kindNames: field.kinds.flatMap(
          (link) => kinds.find((kind) => kind.id === link.kindId)?.name ?? [],
        ),
        options: field.options.map((option) => ({
          id: option.id,
          label: option.label,
          archived: Boolean(option.archivedAt),
        })),
      })),
  };
}

export async function saveListColumns(actor: AuditActor, scope: ListScope, input: string[]) {
  const columns = await txWithAudit(actor, async (tx, audit) => {
    await lockDefinitions(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(194031, 2)`;
    const active = (await getDefinitions(scope, tx)).filter((field) => !field.archivedAt);
    if (
      input[0] !== "name" ||
      input.length > 12 ||
      new Set(input).size !== input.length ||
      input.some((id) => !DEFAULT_COLUMNS[scope].includes(id) && !id.startsWith("field:"))
    )
      throw new ValidationError({ columns: [tr("fields.columns.invalid")] });
    const columns = resolveColumns(scope, input, active);
    const before = await tx.listColumns.findUnique({ where: { scope } });
    await tx.listColumns.upsert({
      where: { scope },
      create: { scope, columns },
      update: { columns },
    });
    await audit({
      action: "ListColumnsChanged",
      entityType: "listColumns",
      entityId: scope,
      data: { before: before?.columns ?? DEFAULT_COLUMNS[scope], after: columns },
    });
    return columns;
  });
  await emitChange({ entityType: "listColumns", id: scope, op: "updated" });
  return columns;
}

export async function withListValues<T extends { id: string; kind?: { id: string } }>(
  scope: ListScope,
  records: T[],
  columns: string[],
) {
  const ids = columns.filter((id) => id.startsWith("field:")).map((id) => id.slice(6));
  if (!ids.length || !records.length)
    return records.map((record) => ({ ...record, values: {} as Record<string, ListValue> }));
  const fields = (await getDefinitions(scope)).filter(
    (field) => !field.archivedAt && ids.includes(field.id),
  );
  const table = scope === "ROOM" ? Prisma.sql`"Room"` : Prisma.sql`"Equipment"`;
  const selected = await db.$queryRaw<{ id: string; values: unknown }[]>(Prisma.sql`
    SELECT r.id, COALESCE((SELECT jsonb_object_agg(v.key, v.value)
      FROM jsonb_each(r."customValues") v WHERE v.key IN (${Prisma.join(ids)})), '{}'::jsonb) AS values
    FROM ${table} r WHERE r.id IN (${Prisma.join(records.map((record) => record.id))})
  `);
  const values = new Map(selected.map((record) => [record.id, valueObject(record.values)]));
  return records.map((record) => ({
    ...record,
    values: Object.fromEntries(
      fields.flatMap((field) => {
        const value = values.get(record.id)?.[field.id];
        return value != null && (scope === "ROOM" || applies(field, record.kind?.id))
          ? [[field.id, value as ListValue]]
          : [];
      }),
    ),
  }));
}
