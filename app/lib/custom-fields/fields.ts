import type { FieldDefinition } from "./definitions.server";

export type Field = Pick<
  FieldDefinition,
  "id" | "key" | "name" | "type" | "unit" | "section" | "helpText" | "position" | "kinds"
> & { options: { id: string; label: string; archived: boolean }[] };

export type FilledField = Pick<Field, "id" | "name" | "type" | "section" | "position" | "unit"> & {
  value: string | number | boolean | string[];
};

export function applies(field: { kinds: { kindId: string }[] }, kindId?: string | null) {
  return field.kinds.length === 0 || field.kinds.some((link) => link.kindId === kindId);
}

export function valueObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function fieldGroups<T extends { section: string | null; position: number }>(fields: T[]) {
  const groups = new Map<string, T[]>();
  for (const field of [...fields].sort((a, b) => a.position - b.position)) {
    const section = field.section || "";
    groups.set(section, [...(groups.get(section) ?? []), field]);
  }
  return [...groups].map(([section, fields]) => ({ section, fields }));
}

export function inputValue(field: Field, value: unknown): string | string[] {
  if (field.type === "MULTI_CHOICE")
    return Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
  return value == null ? "" : String(value);
}

export function postedValue(field: Pick<Field, "type">, raw: string | string[]): unknown {
  if (field.type === "MULTI_CHOICE") {
    const values = (Array.isArray(raw) ? raw : [raw]).filter((value) => value !== "");
    return values.length ? values : null;
  }
  if (Array.isArray(raw)) return raw;
  if (!raw.trim()) return null;
  if (field.type === "NUMBER")
    return /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(raw.trim())
      ? Number(raw.trim().replace(",", "."))
      : NaN;
  if (field.type === "BOOLEAN") return raw === "true" ? true : raw === "false" ? false : raw;
  if (field.type === "LONG_TEXT") return raw.replace(/\r\n?/g, "\n");
  return raw;
}

export function sameValue(a: unknown, b: unknown) {
  if (typeof a === "number" && !Number.isFinite(a)) return false;
  const normalize = (v: unknown) =>
    Array.isArray(v) ? (v.length ? [...v].sort() : null) : v === "" || v == null ? null : v;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
