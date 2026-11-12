import { z } from "zod";
import type { Tx } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { Prisma, type CustomFieldScope, type EquipmentCategory } from "~/generated/prisma/client";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";
import { ValidationError, NotFoundError } from "~/lib/errors.server";
import { optionalHttpUrl } from "~/lib/validation.server";
import { tr } from "~/i18n/request-locale.server";
import {
  applies,
  getDefinitions,
  lockDefinitions,
  type FieldDefinition,
} from "./definitions.server";
import type { CustomValuesInput } from "./values.schema";
import { fieldString } from "./definitions.schema";

type Value = string | number | boolean | string[];
type ValueError = { field: string; code: string; allowed?: string[] };
export class CustomValuesError extends ValidationError {
  constructor(
    readonly errors: ValueError[],
    messages: Record<string, string[]>,
  ) {
    super(messages);
  }
}

let compiled:
  { signature: string; schema: z.ZodType<Record<string, Value | null | undefined>> } | undefined;
export function compileCustomValues(
  definitions: FieldDefinition[],
  kindId?: string | null,
  by: "key" | "id" = "key",
) {
  const signature = JSON.stringify([definitions, kindId, by]);
  if (compiled?.signature === signature) return compiled.schema;
  const shape: Record<string, z.ZodType<Value | null | undefined>> = {};
  for (const field of definitions) {
    if (field.archivedAt || !applies(field, kindId)) continue;
    const choice = fieldString.transform((value, ctx) => {
      const option =
        field.options.find((option) => !option.archivedAt && option.id === value) ??
        field.options.find(
          (option) => !option.archivedAt && option.label.toLowerCase() === value.toLowerCase(),
        );
      if (option) return option.id;
      ctx.addIssue({ code: "custom", message: "unknown_option" });
      return z.NEVER;
    });
    let rule: z.ZodType<Value>;
    switch (field.type) {
      case "TEXT":
        rule = fieldString.refine((value) => Array.from(value).length <= 200, "limit");
        break;
      case "LONG_TEXT":
        rule = fieldString.refine((value) => Array.from(value).length <= 4000, "limit");
        break;
      case "NUMBER":
        rule = z.number().refine((value) => {
          const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
          return (coefficient.split(".")[1]?.length ?? 0) - Number(exponent) <= 6;
        });
        break;
      case "BOOLEAN":
        rule = z.boolean();
        break;
      case "DATE":
        rule = z.iso.date();
        break;
      case "LINK":
        rule = fieldString
          .refine((value) => optionalHttpUrl.safeParse(value).success && value.trim() !== "")
          .transform((value) => value.trim());
        break;
      case "CHOICE":
        rule = choice;
        break;
      case "MULTI_CHOICE":
        rule = z.array(choice).refine((values) => new Set(values).size === values.length);
        break;
    }
    shape[field[by]] = rule.nullable().optional();
  }
  const schema = z.object(shape).strict();
  compiled = { signature, schema };
  return schema;
}

export function validateCustomValues(
  definitions: FieldDefinition[],
  values: CustomValuesInput,
  kindId?: string | null,
  by: "key" | "id" = "key",
) {
  const errors: ValueError[] = [];
  const messages: Record<string, string[]> = Object.create(null);
  const known = new Map(definitions.map((field) => [field[by], field]));
  const candidates: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(values)) {
    const field = known.get(key);
    const code = !field
      ? "unknown_field"
      : field.archivedAt
        ? "archived_field"
        : !applies(field, kindId)
          ? "not_applicable"
          : null;
    if (code) {
      errors.push({ field: field?.key ?? key, code });
      messages[key] = [
        tr(
          code === "unknown_field"
            ? "fields.error.unknown"
            : code === "archived_field"
              ? "fields.error.archived"
              : "fields.error.applicable",
        ),
      ];
    } else candidates[key] = value;
  }
  const parsed = compileCustomValues(definitions, kindId, by).safeParse(candidates);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      if (messages[key]) continue;
      const field = known.get(key)!;
      const limit = issue.code === "too_big" || issue.message === "limit";
      const code = limit
        ? "limit"
        : field.type === "NUMBER"
          ? "not_a_number"
          : field.type === "CHOICE" || field.type === "MULTI_CHOICE"
            ? "unknown_option"
            : "invalid_value";
      const allowed =
        code === "unknown_option"
          ? field.options.filter((option) => !option.archivedAt).map((option) => option.label)
          : undefined;
      errors.push({ field: field.key, code, ...(allowed ? { allowed } : {}) });
      messages[key] = [
        tr(
          limit
            ? field.type === "TEXT"
              ? "fields.limit.text"
              : "fields.limit.longText"
            : code === "not_a_number"
              ? "fields.error.number"
              : code === "unknown_option"
                ? "fields.error.option"
                : "fields.error.value",
        ),
      ];
    }
  if (errors.length) throw new CustomValuesError(errors, messages);
  const set: Record<string, Value> = Object.create(null);
  const removed: string[] = [];
  for (const [key, value] of Object.entries(parsed.data!)) {
    const field = known.get(key)!;
    if (value === null) removed.push(field.id);
    else if (value !== undefined) set[field.id] = value;
  }
  return { set, removed };
}

function rendered(
  field: FieldDefinition,
  value: Prisma.JsonValue | undefined,
  markRetired = false,
): Prisma.JsonValue {
  if (value === undefined || value === null) return null;
  const option = (id: unknown) => {
    const found = field.options.find((option) => option.id === id);
    return found
      ? found.archivedAt && markRetired
        ? tr("fields.option.retired", { label: found.label })
        : found.label
      : null;
  };
  if (field.type === "CHOICE") return option(value);
  if (field.type === "MULTI_CHOICE")
    return (Array.isArray(value) ? value : [value]).map(option).filter((label) => label !== null);
  return value;
}

export async function prepareCustomValues(
  tx: Tx,
  scope: CustomFieldScope,
  id: string,
  values: CustomValuesInput,
  kindId?: string | null,
) {
  await lockDefinitions(tx);
  const table = scope === "ROOM" ? Prisma.sql`"Room"` : Prisma.sql`"Equipment"`;
  const rows = await tx.$queryRaw<
    Array<{ customValues: Prisma.JsonObject; kindId?: string | null; category?: EquipmentCategory }>
  >(
    Prisma.sql`SELECT "customValues" ${scope === "EQUIPMENT" ? Prisma.sql`, "kindId", "category"` : Prisma.empty} FROM ${table} WHERE id = ${id} FOR UPDATE`,
  );
  if (!rows[0]) throw new NotFoundError();
  const before = rows[0]?.customValues ?? {};
  if (kindId === undefined && rows[0]?.kindId == null && rows[0]?.category)
    kindId = (
      await tx.equipmentKind.findUnique({
        where: { systemKey: DEFAULT_EQUIPMENT_KINDS[rows[0].category].key },
        select: { id: true },
      })
    )?.id;
  const definitions = await getDefinitions(scope, tx);
  const patch = validateCustomValues(
    definitions,
    values,
    kindId === undefined ? rows[0]?.kindId : kindId,
  );
  const size = await tx.$queryRaw<
    Array<{ bytes: number }>
  >`SELECT pg_column_size((${JSON.stringify(before)}::jsonb || ${JSON.stringify(patch.set)}::jsonb) - ${patch.removed}::text[]) AS bytes`;
  if (size[0].bytes > 32768)
    throw new CustomValuesError([{ field: "customValues", code: "limit" }], {
      customValues: [tr("fields.limit.bytes")],
    });
  const truncate = (value: Prisma.JsonValue): Prisma.JsonValue => {
    if (Array.isArray(value)) value = value.join(", ");
    return typeof value === "string" ? Array.from(value).slice(0, 200).join("") : value;
  };
  const changes = [...Object.keys(patch.set), ...patch.removed].flatMap((fieldId) => {
    if (JSON.stringify(before[fieldId] ?? null) === JSON.stringify(patch.set[fieldId] ?? null))
      return [];
    const field = definitions.find((field) => field.id === fieldId)!;
    return [
      {
        key: field.key,
        name: field.name,
        from: truncate(rendered(field, before[fieldId])),
        to: truncate(rendered(field, patch.set[fieldId])),
      },
    ];
  });
  return {
    ...patch,
    auditData: {
      custom: changes.slice(0, 20),
      ...(changes.length > 20 ? { customMore: changes.length - 20 } : {}),
    },
  };
}

export async function withCustomValues<T extends { id: string }>(
  scope: CustomFieldScope,
  records: T[],
  includeDefinitions = false,
) {
  if (!records.length) return [];
  return txWithAudit(null, async (tx) => {
    await lockDefinitions(tx);
    const definitions = await getDefinitions(scope, tx);
    const ids = records.map((record) => record.id);
    const rows =
      scope === "ROOM"
        ? await tx.room.findMany({
            where: { id: { in: ids } },
            select: { id: true, customValues: true },
          })
        : await tx.equipment.findMany({
            where: { id: { in: ids } },
            select: { id: true, customValues: true, kindId: true, category: true },
          });
    const defaults =
      scope === "EQUIPMENT" && rows.some((row) => "kindId" in row && !row.kindId)
        ? await tx.equipmentKind.findMany({ select: { id: true, systemKey: true } })
        : [];
    return records.map((record) => {
      const row = rows.find((row) => row.id === record.id);
      const kindId =
        row && "kindId" in row && typeof row.kindId === "string"
          ? row.kindId
          : row && "category" in row
            ? defaults.find(
                (kind) =>
                  kind.systemKey === DEFAULT_EQUIPMENT_KINDS[row.category as EquipmentCategory].key,
              )?.id
            : undefined;
      const applicable = definitions.filter((field) => !field.archivedAt && applies(field, kindId));
      const stored = (row?.customValues ?? {}) as Prisma.JsonObject;
      const customValues = Object.fromEntries(
        applicable
          .filter((field) => Object.hasOwn(stored, field.id))
          .map((field) => [field.key, rendered(field, stored[field.id], true)]),
      );
      return {
        ...record,
        customValues,
        ...(includeDefinitions ? { customFields: applicable } : {}),
      };
    });
  });
}
