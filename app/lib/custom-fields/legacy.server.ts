import type { Prisma } from "~/generated/prisma/client";
import type { ResolvedField } from "./schema.server";
import { applies, valueObject, conditionHolds } from "./fields";
import { berlinLocalToUtc } from "~/lib/time.server";
import { berlinDateInput } from "~/lib/format-date";
import { compileCustomValues } from "./values.server";
import type { FilledField } from "./fields";

export const legacyProperties = {
  micKind: "microphone.type",
  frequencyMhz: "frequency",
  band: "band_variant",
  channelLabel: "channel_name",
  lastLampChangeAt: "projector.lamp_change",
  color: "colour",
  dellServiceTag: "service_code",
} as const;

const micOptions = {
  HANDHELD: "handheld_transmitter",
  BODYPACK: "bodypack_transmitter",
  GOOSENECK: "gooseneck",
} as const;

export function unmigratedLegacyValues(
  fields: ResolvedField[],
  device: Partial<Record<keyof typeof legacyProperties, unknown>> & {
    customValues: unknown;
    model?: { customValues: unknown } | null;
  },
  kindId: string,
): FilledField[] {
  const values = legacyPropertyValues(fields, kindId, device, device.customValues);
  return fields.flatMap((field): FilledField[] => {
    if (
      field.hidden ||
      !conditionHolds(field, fields, device.customValues, device.model?.customValues) ||
      !Object.hasOwn(values, field.key) ||
      compileCustomValues([{ ...field, archivedAt: null }], kindId).safeParse({
        [field.key]: values[field.key],
      }).success
    )
      return [];
    const column = Object.keys(legacyProperties).find(
      (column) => legacyProperties[column as keyof typeof legacyProperties] === field.libraryKey,
    )!;
    return [
      {
        id: field.id,
        name: field.name,
        type: "TEXT",
        section: field.section,
        position: field.position,
        unit: null,
        value: String(device[column as keyof typeof legacyProperties]),
        from: "device",
        origin: "library",
        weight: "must",
        legacyColumn: column,
      },
    ];
  });
}

export function legacyPropertyValues(
  fields: ResolvedField[],
  kindId: string | null,
  input: Partial<Record<keyof typeof legacyProperties, unknown>>,
  stored?: unknown,
) {
  const values: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(legacyProperties)) {
    if (!Object.hasOwn(input, column) || input[column as keyof typeof input] === undefined)
      continue;
    const field = fields.find((field) => field.libraryKey === key && applies(field, kindId));
    if (!field || (stored !== undefined && valueObject(stored)[field.id] != null)) continue;
    const raw = input[column as keyof typeof input];
    if (raw == null) {
      if (stored === undefined) values[field.key] = null;
    } else if (column === "micKind") {
      const option = micOptions[raw as keyof typeof micOptions];
      const id = field.options.find((entry) => entry.systemKey === option)?.id;
      if (id) values[field.key] = id;
    } else
      values[field.key] =
        column === "frequencyMhz"
          ? Number(raw)
          : column === "lastLampChangeAt"
            ? berlinDateInput(raw as Date)
            : raw;
  }
  return values;
}

export function legacyColumnValues(
  fields: ResolvedField[],
  values: Record<string, unknown>,
): Prisma.EquipmentUncheckedUpdateInput {
  const columns: Record<string, unknown> = {};
  for (const [column, key] of Object.entries(legacyProperties)) {
    const field = fields.find((field) => field.libraryKey === key);
    if (!field || !Object.hasOwn(values, field.id)) continue;
    const value = values[field.id];
    columns[column] =
      value == null
        ? null
        : column === "micKind"
          ? (Object.entries(micOptions).find(
              ([, key]) => key === field.options.find((option) => option.id === value)?.systemKey,
            )?.[0] ?? null)
          : column === "lastLampChangeAt"
            ? berlinLocalToUtc(`${value}T00:00`)
            : value;
  }
  return columns as Prisma.EquipmentUncheckedUpdateInput;
}

export function retainLegacyColumns(
  fields: ResolvedField[],
  kindId: string,
  input: Record<string, unknown>,
): Prisma.EquipmentUncheckedUpdateInput {
  return Object.fromEntries(
    Object.entries(legacyProperties).map(([column, key]) => [
      column,
      input[column] === undefined &&
      fields.some((field) => field.libraryKey === key && applies(field, kindId))
        ? undefined
        : (input[column] ?? null),
    ]),
  ) as Prisma.EquipmentUncheckedUpdateInput;
}
