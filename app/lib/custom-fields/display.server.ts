import type { FilledField } from "./fields";
import type { CustomFieldScope } from "~/generated/prisma/client";
import { withCustomValues, rendered } from "./values.server";
import { getFieldSchema } from "./schema.server";
import { valueObject } from "./fields";
import type { Prisma } from "~/generated/prisma/client";

export async function modelFieldValues(model: { kind: { id: string }; customValues: unknown }) {
  const fields = (await getFieldSchema("EQUIPMENT", { kindId: model.kind.id })).filter(
    (field) => !field.hidden && field.level === "MODEL",
  );
  const stored = valueObject(model.customValues);
  return fields.flatMap((field): FilledField[] => {
    const value = rendered(field, stored[field.id] as Prisma.JsonValue, true);
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) return [];
    return [
      {
        id: field.id,
        name: field.name,
        type: field.type,
        section: field.section,
        unit: field.unit?.label ?? null,
        position: field.position,
        weight: field.weight,
        value: value as FilledField["value"],
      },
    ];
  });
}

export async function withFieldValues<T extends { id: string }>(
  scope: CustomFieldScope,
  records: T[],
) {
  const read = await withCustomValues(scope, records, true);
  return read.map(({ customFields, customValues, customValueOrigins, ...record }) => ({
    ...record,
    fields: (customFields ?? []).flatMap((field): FilledField[] => {
      const value = customValues[field.key];
      if (value == null || value === "" || (Array.isArray(value) && !value.length)) return [];
      return [
        {
          id: field.id,
          name: field.name,
          type: field.type,
          section: field.section,
          unit: field.unit?.label ?? null,
          from: customValueOrigins[field.key],
          origin: field.origin,
          weight: field.weight,
          position: field.position,
          value: value as FilledField["value"],
        },
      ];
    }),
  }));
}
