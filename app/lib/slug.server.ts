/**
 * Slug derivation, consumed by the self-service add-room form and the importer; implied by
 * `Room.slug @unique` / `Campus.slug @unique`.
 * German-aware: transliterates umlauts before stripping diacritics.
 */

const TRANSLITERATE: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  Ä: "ae",
  Ö: "oe",
  Ü: "ue",
  ß: "ss",
};

export function deriveSlug(input: string): string {
  const transliterated = input.replace(/[äöüÄÖÜß]/g, (c) => TRANSLITERATE[c] ?? c);
  return transliterated
    .normalize("NFKD") // split remaining accents into base + combining marks
    .replace(/[̀-ͯ]/g, "") // drop combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, "") // trim hyphens
    .replace(/-{2,}/g, "-"); // collapse repeats
}

/**
 * Derive a slug that is unique according to `exists`. Appends -2, -3, … on
 * collision. `exists(slug)` returns true if the slug is already taken.
 */
export async function ensureUniqueSlug(
  input: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const base = deriveSlug(input) || "item";
  if (!(await exists(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }
}
