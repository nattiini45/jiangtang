import type { CustomFieldScope } from "~/generated/prisma/client";
import { db, type Tx } from "~/lib/db.server";
import type { Locale } from "~/i18n/locales";
import { currentLocale } from "~/i18n/request-locale.server";
import { libraryProperties, propertyLibrary } from "~/lib/equipment-kinds/properties";
import { getDefinitions, type FieldDefinition } from "./definitions.server";
import { fieldType } from "./definitions.schema";
import { applies, valueObject } from "./fields";

export type ResolvedField = Omit<FieldDefinition, "unit" | "type"> & {
  type: (typeof fieldType.options)[number];
  libraryKey: string | null;
  origin: "library" | "own";
  unit: { key: string; label: string } | null;
  weight: "must" | "useful" | "special";
  nature: string | null;
  appliesIf: { property: string; values: string[] } | null;
  hidden: boolean;
  options: (FieldDefinition["options"][number] & { key: string | null })[];
};

export async function getFieldSchema(
  scope: CustomFieldScope,
  { kindId, locale = currentLocale() }: { kindId?: string | null; locale?: Locale } = {},
  tx: Tx = db,
): Promise<ResolvedField[]> {
  return (await getDefinitions(scope, tx))
    .flatMap((row): ResolvedField[] => {
      const type = fieldType.safeParse(row.type);
      if (!type.success || (kindId !== undefined && !applies(row, kindId))) return [];
      const property = row.systemKey ? libraryProperties.get(row.systemKey) : undefined;
      const unit = property?.unit
        ? propertyLibrary.units.find((unit) => unit.key === property.unit)
        : null;
      return [
        {
          ...row,
          type: type.data,
          name: property && !row.renamed ? property[locale] : row.name,
          helpText: property ? property.help[locale] : row.helpText,
          unit: property
            ? unit
              ? { key: unit.key, label: unit[locale] }
              : null
            : row.unit
              ? { key: row.unit, label: row.unit }
              : null,
          libraryKey: property?.key ?? null,
          origin: property ? "library" : "own",
          weight: property?.weight ?? "useful",
          nature: property?.nature ?? null,
          appliesIf: property?.appliesIf ?? null,
          hidden: !!row.archivedAt,
          options: row.options.map((option) => ({
            ...option,
            key: option.systemKey,
            label:
              property?.options.find((entry) => entry.key === option.systemKey)?.[locale] ??
              option.label,
          })),
        },
      ];
    })
    .sort(
      (a, b) =>
        Number(a.origin === "own") - Number(b.origin === "own") ||
        ["must", "useful", "special"].indexOf(a.weight) -
          ["must", "useful", "special"].indexOf(b.weight) ||
        a.position - b.position,
    );
}

export function effectiveValues(
  fields: Pick<ResolvedField, "id" | "level">[],
  device: unknown,
  model?: unknown,
) {
  const own = valueObject(device),
    shared = valueObject(model);
  return Object.fromEntries(
    fields.map((field) => {
      const from: "model" | "device" =
        field.level === "MODEL" && shared[field.id] != null ? "model" : "device";
      return [field.id, { value: (from === "model" ? shared : own)[field.id], from }];
    }),
  );
}
