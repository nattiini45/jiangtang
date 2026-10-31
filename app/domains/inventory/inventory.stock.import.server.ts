import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import type { InventoryItem } from "~/generated/prisma/client";
import { createStockInTx } from "./inventory.stock.mutations.server";
import type { StockCreateInput } from "./inventory.stock.schema";

/**
 * Bulk stock import — the `bulkCreateEquipment` precedent applied to
 * `InventoryItem`.
 *
 * **Two rules the corpus does not state and this file therefore owns:**
 *
 * 1. **All-or-nothing per file.** One refused row aborts the whole file and
 *    writes nothing — *not even the audit rows of the rows that had already been
 *    inserted*, because they are inside the same transaction (an audit row
 *    commits with the change or not at all). The alternative — skip the bad row,
 *    import the rest — is what a spreadsheet means by "import", and it is how a
 *    stock count silently becomes a partial stock count. A refused file is
 *    refused *before* the first insert, so the common case writes nothing at all.
 * 2. **The refusal names the row.** `ValidationError` carries messages; a message
 *    that does not say *which line* is unusable in a 30-row file, so every refusal
 *    below is prefixed with the CSV line number (`previewCsv`'s 1-based count,
 *    header included). This is why the rows arrive **with** their line numbers
 *    instead of as bare objects: the line is part of the import's input, not
 *    something the domain has to guess.
 *
 * **The row's own column names are the schema's field names** — the CSV is keyed
 * the way `stockCreateSchema` is, so there is no translation layer that can drift
 * from the domain, and a new column needs no second edit. (The Equipment importer
 * maps German headers through `equipmentCsvRowSchema`; that is a deliberate
 * divergence, recorded.)
 */

/** One CSV line, already validated by `previewCsv` + `stockCreateSchema`. */
export interface StockImportRow {
  /** 1-based CSV line, header included — so the number a user sees is this number. */
  line: number;
  data: StockCreateInput;
}

/** The two unique keys, in the order a message should mention them. */
const UNIQUE_FIELDS = ["sku", "serial"] as const;

/** Prefixed with the line, so a refusal in a 30-row file is findable. */
function label(field: (typeof UNIQUE_FIELDS)[number]): string {
  return tr(field === "serial" ? "places.err.stock.label.serial" : "places.err.stock.label.sku");
}

/**
 * 🔴 **A duplicate *inside the file* is caught here, before the transaction, and
 * that is not an optimisation — it is the only way to name the row.**
 *
 * A `sku` repeated twice in one file would be refused by the unique index on
 * the second INSERT, and the whole file would roll back correctly, but the error
 * Postgres raises names a *constraint*, not a *spreadsheet row*. Checking the file
 * first turns "23505 on InventoryItem_sku_key" into "Zeile 12: SKU … ist in dieser
 * Datei doppelt (zuerst Zeile 4)".
 *
 * ⚠️ **A blank cell is not a duplicate, and this is the line that proves it.**
 * `optionalText` resolves `""` to `undefined`, `stockData` writes
 * `undefined` as `NULL`, and the unique index keeps NULLs distinct — the ordinary case
 * for loose stock. A pre-flight check that compared the resolved values without
 * skipping `undefined` would reject a perfectly legal file of unnamed items, and
 * would do it with a message claiming a duplicate that does not exist. So the
 * `undefined` case is skipped explicitly, and the test file asserts two blank SKUs
 * import as two rows.
 */
function refuseInFileDuplicates(rows: StockImportRow[]): void {
  const firstSeen = new Map<string, number>();
  for (const row of rows) {
    for (const field of UNIQUE_FIELDS) {
      const value = row.data[field];
      if (value === undefined) continue;
      const key = `${field}\u0000@${value}`;
      const first = firstSeen.get(key);
      if (first !== undefined) {
        throw new ValidationError({}, [
          tr("places.err.stock.importDuplicate", {
            line: row.line,
            label: label(field),
            value,
            first,
          }),
        ]);
      }
      firstSeen.set(key, row.line);
    }
  }
}

/**
 * Re-raise a row's own refusal with the line number attached, keeping the field
 * names in the message text (this is what a CSV import can render — there is no
 * form to put a field error next to).
 */
function withLine(error: ValidationError, line: number): ValidationError {
  const detail = [
    ...Object.entries(error.fieldErrors).flatMap(([field, messages]) =>
      messages.map((m) => `${field}: ${m}`),
    ),
    ...error.formErrors,
  ];
  return new ValidationError({}, [
    tr("places.err.stock.importLine", { line, detail: detail.join("; ") }),
  ]);
}

/**
 * Import validated CSV rows as one transaction — whole-file atomicity, the
 * `bulkCreateEquipment` contract.
 *
 * **Every row is written by `createStockInTx`**, the same function
 * `createStockItem` uses, so a column added tomorrow is imported by both paths
 * without a second edit — and so a duplicate is refused by the same
 * database constraint, translated by the same code, in both paths. Each row gets its
 * own `InventoryItemCreated` audit row inside the transaction, with
 * `viaImport: true` beside the values (the Equipment import's convention), so an
 * import is distinguishable in `/activity` from a hand-typed create.
 *
 * The generous timeout is `bulkCreateEquipment`'s: dozens of sequential row
 * round-trips in one transaction can exceed Prisma's ~5 s default and abort with
 * `P2028`.
 */
export async function bulkCreateStock(
  actor: AuditActor,
  rows: StockImportRow[],
): Promise<{ created: number; items: InventoryItem[] }> {
  refuseInFileDuplicates(rows);

  return txWithAudit(
    actor,
    async (tx, audit) => {
      const items: InventoryItem[] = [];
      for (const row of rows) {
        let item: InventoryItem;
        try {
          item = await createStockInTx(tx, row.data, actor?.id ?? null);
        } catch (error) {
          // A refusal is re-raised with its line, never swallowed: a file that
          // skips a duplicate `sku` is a partial import, which is the thing this
          // function exists to prevent.
          if (error instanceof ValidationError) throw withLine(error, row.line);
          throw error;
        }
        await audit({
          action: "InventoryItemCreated",
          entityType: "inventory-item",
          entityId: item.id,
          data: {
            name: item.name,
            sku: item.sku,
            serial: item.serial,
            quantity: item.quantity,
            viaImport: true,
          },
        });
        items.push(item);
      }
      return { created: items.length, items };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
