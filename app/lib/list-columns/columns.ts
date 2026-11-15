import type { Field } from "~/lib/custom-fields/fields";
import type { Locale } from "~/i18n/locales";
import { t } from "~/i18n";
import { formatDate, formatNumber } from "~/i18n/format";

export type ListScope = "ROOM" | "EQUIPMENT";
export const DEFAULT_COLUMNS = {
  ROOM: [
    "name",
    "roomNumber",
    "campusName",
    "status",
    "capacity",
    "equipmentCount",
    "knownIssues",
    "lastCheckedAt",
  ],
  EQUIPMENT: ["name", "kind", "assetTag", "roomName", "modelName", "status"],
} satisfies Record<ListScope, string[]>;
export type ListField = Pick<Field, "id" | "name" | "type" | "unit" | "options"> & {
  kindNames: string[];
};
export type ListValue = string | number | boolean | string[];
export type ListValues = { values: Record<string, ListValue> };
export type ListColumns = { columns: string[]; fields: ListField[] };
export const fieldColumnId = (id: string) => `field:${id}`;

export function resolveColumns(
  scope: ListScope,
  stored: string[] | undefined,
  fields: { id: string }[],
) {
  const allowed = new Set([
    ...DEFAULT_COLUMNS[scope],
    ...fields.map((field) => fieldColumnId(field.id)),
  ]);
  return [
    "name",
    ...new Set((stored ?? DEFAULT_COLUMNS[scope]).filter((id) => id !== "name" && allowed.has(id))),
  ].slice(0, 12);
}

export function fieldSortValue(
  field: ListField,
  value: ListValue | undefined,
): string | number | undefined {
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return undefined;
  if (field.type === "BOOLEAN") return Number(value);
  if (field.type === "CHOICE" || field.type === "MULTI_CHOICE") {
    const selected = Array.isArray(value) ? value : [value];
    const index = field.options.findIndex((option) => selected.includes(option.id));
    return index < 0 ? undefined : index;
  }
  return typeof value === "number" ? value : String(value);
}

export function fieldDisplayValue(
  field: ListField,
  value: ListValue | undefined,
  locale: Locale,
): ListValue | undefined {
  const label = (id: string) => {
    const option = field.options.find((option) => option.id === id);
    return option
      ? option.archived
        ? t(locale, "fields.option.retired", { label: option.label })
        : option.label
      : undefined;
  };
  if (field.type === "CHOICE") return typeof value === "string" ? label(value) : undefined;
  if (field.type === "MULTI_CHOICE")
    return Array.isArray(value) ? value.flatMap((id) => label(id) ?? []) : undefined;
  return value;
}

export function fieldText(field: ListField, raw: ListValue | undefined, locale: Locale): string {
  const value = fieldDisplayValue(field, raw, locale);
  if (value == null || value === "" || (Array.isArray(value) && !value.length)) return "—";
  if (field.type === "BOOLEAN") return t(locale, value ? "fields.form.yes" : "fields.form.no");
  if (field.type === "NUMBER" && typeof value === "number")
    return `${formatNumber(locale, value, { maximumFractionDigits: 6 })}${field.unit ? ` ${field.unit}` : ""}`;
  if (field.type === "DATE") return formatDate(locale, `${value}T12:00:00Z`);
  return Array.isArray(value) ? value.join(", ") : String(value);
}
