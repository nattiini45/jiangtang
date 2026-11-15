import type { FieldDefinition } from "./definitions.server";

export function deriveFieldKey(name: string, taken: Iterable<string>) {
  const keys = new Set(taken);
  const stem = name
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .replace(/[^a-z0-9]/g, "_")
    .replace(/^_+|_+$/g, "");
  const base = (/^[a-z]/.test(stem) ? stem : `field_${stem}`).slice(0, 40);
  let key = base;
  for (let n = 2; keys.has(key); n++) {
    const suffix = `_${n}`;
    key = base.slice(0, 40 - suffix.length) + suffix;
  }
  return key;
}

export function previewOptions(
  text: string,
  options: Pick<FieldDefinition["options"][number], "label" | "archivedAt">[],
) {
  const seen = new Set(options.map((option) => option.label.toLowerCase()));
  let active = options.filter((option) => !option.archivedAt).length;
  let total = options.length;
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label) => {
      const normalized = label.toLowerCase();
      const status: "repeat" | "invalid" | "limit" | "new" = seen.has(normalized)
        ? "repeat"
        : label.length > 80
          ? "invalid"
          : active >= 50 || total >= 200
            ? "limit"
            : "new";
      seen.add(normalized);
      if (status === "new") {
        active++;
        total++;
      }
      return { label, status };
    });
}
