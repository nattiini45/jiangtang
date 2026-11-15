import { z } from "zod";
import type { Tx } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { Prisma, type CustomFieldScope, type EquipmentCategory } from "~/generated/prisma/client";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";
import { ValidationError, NotFoundError } from "~/lib/errors.server";
import { optionalHttpUrl } from "~/lib/validation.server";
import { tr } from "~/i18n/request-locale.server";
import { applies, lockDefinitions, type FieldDefinition } from "./definitions.server";
import type { CustomValuesInput } from "./values.schema";
import { fieldString, fieldType } from "./definitions.schema";
import { getFieldSchema, effectiveValues } from "./schema.server";
import type { RangeValue } from "./fields";
import { sameValue, conditionHolds } from "./fields";
import type { ResolvedField } from "./schema.server";

type ValueDefinition = Pick<
  FieldDefinition,
  "id" | "key" | "type" | "archivedAt" | "kinds" | "name" | "options"
> & { libraryKey?: string | null };

type Value = string | number | boolean | string[] | RangeValue;
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
  definitions: ValueDefinition[],
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
        field.options.find((option) => !option.archivedAt && option.systemKey === value) ??
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
          if (
            field.libraryKey === "frequency" &&
            (Math.abs(value) >= 100000 || Number(value.toFixed(3)) !== value)
          )
            return false;
          const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
          return (coefficient.split(".")[1]?.length ?? 0) - Number(exponent) <= 6;
        });
        break;
      case "BOOLEAN":
        rule = z.boolean();
        break;
      case "RANGE":
        rule = z
          .object({ min: z.number().nullable().optional(), max: z.number().nullable().optional() })
          .strict()
          .refine(({ min, max }) => min != null || max != null)
          .refine(({ min, max }) => min == null || max == null || min <= max)
          .transform(({ min, max }) => ({ min: min ?? null, max: max ?? null }));
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
      default:
        continue;
    }
    shape[field[by]] = rule.nullable().optional();
  }
  const schema = z.object(shape).strict();
  compiled = { signature, schema };
  return schema;
}

export function validateCustomValues(
  definitions: ValueDefinition[],
  values: CustomValuesInput,
  kindId?: string | null,
  by: "key" | "id" = "key",
) {
  const errors: ValueError[] = [];
  const messages: Record<string, string[]> = Object.create(null);
  const known = new Map(
    definitions
      .filter((field) => fieldType.safeParse(field.type).success)
      .flatMap((field) => [
        [field[by], field] as const,
        ...(by === "key" && field.libraryKey ? [[field.libraryKey, field] as const] : []),
      ]),
  );
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
    } else candidates[field![by]] = value;
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

export function rendered(
  field: ValueDefinition,
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

export function validateConditions(
  fields: ResolvedField[],
  patch: ReturnType<typeof validateCustomValues>,
  before: Record<string, unknown>,
  model?: unknown,
) {
  const after = { ...before, ...patch.set };
  for (const id of patch.removed) delete after[id];
  for (const field of fields) {
    if (
      Object.hasOwn(patch.set, field.id) &&
      !sameValue(patch.set[field.id], before[field.id]) &&
      !conditionHolds(field, fields, after, model)
    ) {
      const controller = fields.find((entry) => entry.libraryKey === field.appliesIf?.property)!;
      throw new ValidationError({
        [field.key]: [tr("fields.error.condition", { name: controller.name })],
      });
    }
  }
}

export function customValueChanges(
  definitions: ValueDefinition[],
  before: Prisma.JsonObject,
  patch: ReturnType<typeof validateCustomValues>,
) {
  const truncate = (value: Prisma.JsonValue): Prisma.JsonValue => {
    if (Array.isArray(value)) value = value.join(", ");
    return typeof value === "string" ? Array.from(value).slice(0, 200).join("") : value;
  };
  const changes = [...Object.keys(patch.set), ...patch.removed].flatMap((fieldId) => {
    if (sameValue(before[fieldId], patch.set[fieldId])) return [];
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
    custom: changes.slice(0, 20),
    ...(changes.length > 20 ? { customMore: changes.length - 20 } : {}),
  };
}

export async function prepareCustomValues(
  tx: Tx,
  scope: CustomFieldScope,
  id: string,
  values: CustomValuesInput,
  kindId?: string | null,
  modelId?: string | null,
  deviceFallbackIds: readonly string[] = [],
) {
  await lockDefinitions(tx);
  const table = scope === "ROOM" ? Prisma.sql`"Room"` : Prisma.sql`"Equipment"`;
  const rows = await tx.$queryRaw<
    Array<{
      customValues: Prisma.JsonObject;
      kindId?: string | null;
      category?: EquipmentCategory;
      modelId?: string | null;
    }>
  >(
    Prisma.sql`SELECT "customValues" ${scope === "EQUIPMENT" ? Prisma.sql`, "kindId", "category", "modelId"` : Prisma.empty} FROM ${table} WHERE id = ${id} FOR UPDATE`,
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
  const definitions = await getFieldSchema(scope, {}, tx);
  const effectiveModelId = modelId === undefined ? rows[0].modelId : modelId;
  if (effectiveModelId) {
    const blocked = definitions.find(
      (field) =>
        field.level === "MODEL" &&
        !deviceFallbackIds.includes(field.id) &&
        (Object.hasOwn(values, field.key) ||
          (field.libraryKey && Object.hasOwn(values, field.libraryKey))),
    );
    if (blocked)
      throw new ValidationError({
        [blocked.key]: [tr("fields.model.editOnModel", { modelId: effectiveModelId })],
      });
  }
  const patch = validateCustomValues(
    definitions,
    values,
    kindId === undefined ? rows[0]?.kindId : kindId,
  );
  const modelRows = effectiveModelId
    ? await tx.$queryRaw<
        { customValues: Prisma.JsonObject }[]
      >`SELECT "customValues" FROM "EquipmentModel" WHERE id = ${effectiveModelId} FOR SHARE`
    : [];
  validateConditions(definitions, patch, before, modelRows[0]?.customValues);
  const size = await tx.$queryRaw<
    Array<{ bytes: number }>
  >`SELECT pg_column_size((${JSON.stringify(before)}::jsonb || ${JSON.stringify(patch.set)}::jsonb) - ${patch.removed}::text[]) AS bytes`;
  if (size[0].bytes > 32768)
    throw new CustomValuesError([{ field: "customValues", code: "limit" }], {
      customValues: [tr("fields.limit.bytes")],
    });
  return {
    ...patch,
    auditData: customValueChanges(definitions, before, patch),
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
    const definitions = await getFieldSchema(scope, {}, tx);
    const ids = records.map((record) => record.id);
    const rows =
      scope === "ROOM"
        ? await tx.room.findMany({
            where: { id: { in: ids } },
            select: { id: true, customValues: true },
          })
        : await tx.equipment.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              customValues: true,
              kindId: true,
              category: true,
              model: { select: { customValues: true } },
            },
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
      const modelValues =
        row &&
        "model" in row &&
        row.model &&
        typeof row.model === "object" &&
        "customValues" in row.model
          ? row.model.customValues
          : undefined;
      const applicable = definitions.filter(
        (field) =>
          !field.archivedAt &&
          applies(field, kindId) &&
          conditionHolds(field, definitions, row?.customValues, modelValues),
      );
      const effective = effectiveValues(applicable, row?.customValues, modelValues);
      const customValues = Object.fromEntries(
        applicable
          .filter((field) => effective[field.id].value != null)
          .map((field) => [
            field.key,
            rendered(field, effective[field.id].value as Prisma.JsonValue, true),
          ]),
      );
      return {
        ...record,
        customValues,
        customValueOrigins: Object.fromEntries(
          applicable.map((field) => [field.key, effective[field.id].from]),
        ),
        ...(includeDefinitions ? { customFields: applicable } : {}),
      };
    });
  });
}
