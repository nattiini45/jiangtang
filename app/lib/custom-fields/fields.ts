import type { FieldDefinition } from "./definitions.server";

export type Field = Pick<
  FieldDefinition,
  "id" | "key" | "name" | "unit" | "section" | "helpText" | "position" | "kinds"
> & {
  type: FieldDefinition["type"];
  level?: "MODEL" | "DEVICE";
  weight?: "must" | "useful" | "special";
  origin?: "library" | "own";
  libraryKey?: string | null;
  options: { id: string; label: string; archived: boolean }[];
};

export type RangeValue = { min: number | null; max: number | null };

export type FilledField = Pick<Field, "id" | "name" | "type" | "section" | "position" | "unit"> & {
  value: string | number | boolean | string[] | RangeValue;
  from?: "model" | "device";
  origin?: "own" | "library";
  weight?: "must" | "useful" | "special";
};

export function applies(field: { kinds: { kindId: string }[] }, kindId?: string | null) {
  return field.kinds.length === 0 || field.kinds.some((link) => link.kindId === kindId);
}

export function valueObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function fieldGroups<
  T extends {
    section: string | null;
    position: number;
    weight?: "must" | "useful" | "special";
    origin?: "own" | "library";
  },
>(fields: T[]) {
  const groups = new Map<string, T[]>();
  const rank = (field: T) =>
    field.origin === "own" || !field.weight
      ? 3
      : ["must", "useful", "special"].indexOf(field.weight);
  for (const field of [...fields].sort((a, b) => rank(a) - rank(b) || a.position - b.position)) {
    const section = field.section || "";
    groups.set(section, [...(groups.get(section) ?? []), field]);
  }
  return [...groups].map(([section, fields]) => ({ section, fields }));
}

export function inputValue(field: Field, value: unknown): string | string[] {
  if (field.type === "RANGE") {
    const range = valueObject(value);
    return [range.min == null ? "" : String(range.min), range.max == null ? "" : String(range.max)];
  }
  if (field.type === "MULTI_CHOICE")
    return Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
  return value == null ? "" : String(value);
}

export function postedValue(field: Pick<Field, "type">, raw: string | string[]): unknown {
  if (field.type === "RANGE") {
    if (!Array.isArray(raw) || raw.length !== 2) return raw;
    const [min, max] = raw.map((value) => postedValue({ type: "NUMBER" }, value));
    return min == null && max == null ? null : { min, max };
  }
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
  const finite = (value: unknown): boolean =>
    typeof value === "number"
      ? Number.isFinite(value)
      : value && typeof value === "object"
        ? Object.values(value).every(finite)
        : true;
  if (!finite(a) || !finite(b)) return false;
  const normalize = (v: unknown) =>
    Array.isArray(v)
      ? v.length
        ? [...v].sort()
        : null
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v === "" || v == null
          ? null
          : v;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
