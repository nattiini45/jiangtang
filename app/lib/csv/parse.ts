/**
 * Tiny dependency-free RFC-4180 CSV parser for the bulk-add flows.
 * Pure + client-safe (no `.server` suffix) so the import preview can parse in
 * the browser before anything hits the server.
 *
 * Handles: double-quoted fields, embedded commas/newlines, escaped quotes (""),
 * CRLF or LF line endings, a leading UTF-8 BOM, and a trailing newline.
 */

/** Strip a leading UTF-8 BOM if present. */
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Parse CSV text into rows of raw string fields. Faithful to RFC 4180 — values
 * are NOT trimmed (use {@link parseCsvToObjects} for the lenient onboarding map).
 * Returns `[]` for empty input.
 */
export function parseCsv(input: string): string[][] {
  const text = stripBom(input);
  if (text.length === 0) return [];

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endRow = () => {
    row.push(field);
    field = "";
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      endRow();
      if (text[i + 1] === "\n") i += 2;
      else i++;
      continue;
    }
    if (c === "\n") {
      endRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }

  // Flush the final field/row. Suppress a spurious empty row when the file ended
  // on a newline (endRow already pushed the real last row).
  row.push(field);
  const trailingEmpty = row.length === 1 && row[0] === "";
  if (!(trailingEmpty && rows.length > 0)) rows.push(row);

  return rows;
}

export interface CsvParseResult {
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * Parse CSV into header-keyed objects for bulk add. The first row is the header.
 * Header and value cells are trimmed; ragged rows are padded (missing → "") and
 * truncated to the header width; fully blank lines are skipped. Duplicate header
 * names keep the last occurrence.
 */
export function parseCsvToObjects(input: string): CsvParseResult {
  const rows = parseCsv(input);
  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0].map((h) => h.trim());
  const objects = rows
    .slice(1)
    .filter((r) => !(r.length === 1 && r[0].trim() === "")) // skip blank lines
    .map((r) => {
      // `Object.create(null)` — a header literally named `__proto__` (untrusted
      // CSV input) must not reach onto a plain `{}`'s prototype via the setter,
      // which would pollute Object.prototype for the whole process.
      const obj: Record<string, string> = Object.create(null);
      headers.forEach((h, idx) => {
        obj[h] = (r[idx] ?? "").trim();
      });
      return obj;
    });

  return { headers, rows: objects };
}
