import type { FilledField } from "./fields";
import type { CustomFieldScope } from "~/generated/prisma/client";
import { withCustomValues } from "./values.server";

export async function withFieldValues<T extends { id: string }>(
  scope: CustomFieldScope,
  records: T[],
) {
  const read = await withCustomValues(scope, records, true);
  return read.map(({ customFields, customValues, ...record }) => ({
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
          unit: field.unit,
          position: field.position,
          value: value as FilledField["value"],
        },
      ];
    }),
  }));
}
