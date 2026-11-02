import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { ValidationError } from "~/lib/errors.server";
import { previewCsv } from "~/lib/csv/preview";
import { stockCreateSchema } from "~/domains/inventory/inventory.stock.schema";
import { createStockItem } from "~/domains/inventory/inventory.stock.mutations.server";
import {
  bulkCreateStock,
  type StockImportRow,
} from "~/domains/inventory/inventory.stock.import.server";

/**
 * CSV stock import — guards for (1), (3) and (4).
 *
 *   (1) parsing is `app/lib/csv`'s, validation is `previewCsv` + `stockCreateSchema`,
 *       and every row is written by the SAME mapping the form uses
 *   (2) a blank `quantity` is 1 and a typed `0` is 0 → asserted in
 *       `inventory.stock.test.ts`, beside the schema
 *   (3) all-or-nothing per file, and the refusal names the row
 *   (4) a duplicate — in the file or already in the database — is a row error and
 *       never a partial insert, while two BLANK `sku` cells are not a duplicate
 *
 * ⚠️ **Every test goes through `previewCsv` first, exactly as the route does.** A
 * test that called `bulkCreateStock` with hand-built objects would pass while the
 * shipped path failed, because the defect exists to prevent lives in the
 * SCHEMA the CSV is parsed by — the one thing a hand-built object skips.
 *
 * The CONTROL in the first block is the file's non-vacuity guard: it asks Postgres,
 * with raw SQL, whether the duplicate this file claims to refuse really is refused
 * by the database. Without it, "a duplicate sku is a row error" is equally
 * consistent with a live constraint and with no constraint at all.
 */

const RUN = `imp_${Date.now().toString(36)}`;
const actor = { id: null, name: "Import Tester", initials: "IT" };
const itemIds: string[] = [];
let locationId = "";
let vendorId = "";

/** Exactly the route's pipeline: CSV text → previewCsv + stockCreateSchema → rows. */
function rowsFrom(csv: string): {
  valid: StockImportRow[];
  invalid: { line: number; messages: string[] }[];
} {
  const preview = previewCsv(csv, stockCreateSchema);
  return { valid: preview.valid, invalid: preview.invalid };
}

async function importCsv(csv: string) {
  const { valid, invalid } = rowsFrom(csv);
  if (invalid.length > 0)
    throw new ValidationError({}, [
      `CSV ungültig: ${invalid.map((i) => `Zeile ${i.line}`).join(", ")}`,
    ]);
  return bulkCreateStock(actor, valid);
}

const countRows = (prefix: string) =>
  db.inventoryItem.count({ where: { name: { startsWith: prefix } } });

beforeAll(async () => {
  const location = await db.location.create({ data: { name: `${RUN}-lager`, kind: "STORAGE" } });
  locationId = location.id;
  const vendor = await db.vendor.create({ data: { name: `${RUN}-lieferant` } });
  vendorId = vendor.id;
});

afterAll(async () => {
  await db.inventoryItem.deleteMany({ where: { name: { startsWith: RUN } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.location.deleteMany({ where: { id: locationId } });
  await db.$disconnect();
});

describe("the shipped path, and it is the form's own schema", () => {
  it("(1) CONTROL: Postgres really refuses a duplicate sku, so the row-error tests below are not vacuous", async () => {
    const first = await db.inventoryItem.create({
      data: { name: `${RUN}-ctrl`, sku: `${RUN}-CTRL` },
    });
    itemIds.push(first.id);
    let caught: unknown;
    try {
      await db.inventoryItem.create({ data: { name: `${RUN}-ctrl-dup`, sku: `${RUN}-CTRL` } });
    } catch (error) {
      caught = error;
    }
    expect(caught, "a raw duplicate sku insert must be refused by the database").toBeDefined();
    expect((caught as { code?: string }).code).toBe("P2002");
    // The colliding column, structured out of the adapter's constraint.
    const cause = (
      caught as {
        meta?: { driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } } };
      }
    ).meta?.driverAdapterError?.cause;
    expect(cause?.constraint?.fields).toEqual(["sku"]);
  });

  it("(1) a CSV imports through previewCsv + stockCreateSchema, with the references resolved", async () => {
    const csv = [
      "name,sku,serial,quantity,category,unit,locationId,vendorId",
      `${RUN}-kabel,${RUN}-SKU-1,${RUN}-SER-1,4,Kabel,Stück,${locationId},${vendorId}`,
      `${RUN}-adapter,,${RUN}-SER-2,2,Adapter,Stück,${locationId},`,
    ].join("\n");

    const { valid, invalid } = rowsFrom(csv);
    expect(invalid).toEqual([]);
    expect(valid).toHaveLength(2);
    // Line numbers are 1-based INCLUDING the header, so the number a user sees in
    // their spreadsheet is the number a refusal quotes.
    expect(valid.map((v) => v.line)).toEqual([2, 3]);

    const { created, items } = await bulkCreateStock(actor, valid);
    expect(created).toBe(2);
    itemIds.push(...items.map((i) => i.id));

    for (const [item, expectedCategory] of [
      [items[0], "Kabel"],
      [items[1], "Adapter"],
    ] as const) {
      const row = await db.inventoryItem.findUnique({
        where: { id: item.id },
        include: { location: true, vendor: true },
      });
      expect(row?.locationId).toBe(locationId);
      expect(row?.category).toBe(expectedCategory);
      expect(row?.unit).toBe("Stück");
      expect(row?.location?.id).toBe(locationId);
    }
    expect(items[0].vendorId).toBe(vendorId);
    // A blank cell on the second row is NULL, not "" — the guarantee the import
    // has to reach, or loose stock cannot be typed at all.
    expect(items[1].sku).toBeNull();
    expect(items[1].vendorId).toBeNull();
  });

  it("(1) an imported row is byte-for-byte the same write as a form-created one", async () => {
    // The strongest available proof that the import uses the same `stockData()`
    // mapping as the form, without reading the import's source: the same input
    // through `createStockItem` and through the import must produce the same row.
    // A second `data` mapping in the importer drifts from the first the day a column
    // is added, and this is what would notice.
    const csv = [
      "name,sku,serial,quantity,category,status,unit,purchasedAt,purchasePrice,warrantyExpiresAt,vendorId,locationId",
      `${RUN}-gleich,${RUN}-SKU-GLEICH,${RUN}-SER-GLEICH,7,Mikro,AVAILABLE,Stück,2026-01-15,19.99,2028-03-01,${vendorId},${locationId}`,
    ].join("\n");
    const { valid } = rowsFrom(csv);
    const { items } = await bulkCreateStock(actor, valid);
    itemIds.push(items[0].id);
    const viaImport = items[0];

    // ⚠️ The imported row is removed and re-created through the form, because both
    // unique columns cannot hold the same value twice — the very constraint this
    // file is about. Deleting the item (never its audit row — append-only) is what
    // lets the comparison cover `sku` and `serial` too, instead of quietly dropping
    // the two fields that matter most.
    await db.inventoryItem.delete({ where: { id: viaImport.id } });
    const viaForm = await createStockItem(actor, valid[0].data);
    itemIds.push(viaForm.id);

    const fields = [
      "name",
      "sku",
      "serial",
      "quantity",
      "category",
      "status",
      "unit",
      "purchasedAt",
      "purchasePrice",
      "warrantyExpiresAt",
      "vendorId",
      "locationId",
      "tags",
      "createdById",
    ] as const;
    for (const field of fields) {
      expect(
        { field, value: viaImport[field] },
        `imported.${field} must equal form-written.${field}`,
      ).toEqual({ field, value: viaForm[field] });
    }
    // Sanity: the comparison would be vacuous if both rows were the same object.
    expect(viaForm.id).not.toBe(viaImport.id);
    expect(viaImport.sku).toBe(`${RUN}-SKU-GLEICH`);
  });

  it("a status cell accepts the enum value or the German label, case-insensitively", async () => {
    const csv = [
      "name,status",
      `${RUN}-enum,ON_LOAN`,
      `${RUN}-label,Verliehen`,
      `${RUN}-label-lower,für veranstaltung reserviert`,
      `${RUN}-blank,`,
    ].join("\n");
    const { valid, invalid } = rowsFrom(csv);
    expect(invalid).toEqual([]);
    const { items } = await bulkCreateStock(actor, valid);
    itemIds.push(...items.map((i) => i.id));
    expect(items.map((i) => i.status)).toEqual(["ON_LOAN", "ON_LOAN", "RESERVED_FOR_EVENT", null]);
  });

  it("an unknown status is a row error naming the line — never a silent NULL", async () => {
    const { valid, invalid } = rowsFrom(
      ["name,status", `${RUN}-ok,AVAILABLE`, `${RUN}-kaputt,gibt-es-nicht`].join("\n"),
    );
    expect(invalid).toHaveLength(1);
    expect(invalid[0].line).toBe(3);
    expect(invalid[0].messages.join(" ")).toContain("status");
    // The route refuses the file outright, so the valid row is never offered.
    expect(valid).toHaveLength(1);
    expect(await countRows(`${RUN}-ok`)).toBe(0);
  });

  it("(1) the import writes one audit row per item, inside the transaction, marked as an import", async () => {
    const csv = [`name,quantity`, `${RUN}-audit,1`].join("\n");
    const { items } = await bulkCreateStock(actor, rowsFrom(csv).valid);
    itemIds.push(items[0].id);

    const logs = await db.activityLog.findMany({
      where: { entityType: "inventory-item", entityId: items[0].id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("InventoryItemCreated");
    // `viaImport` is what makes an import distinguishable in /activity from a
    // hand-typed create — the Equipment import's convention, and the only way to
    // answer "who typed in 30 microphones?" later.
    expect(logs[0].data).toMatchObject({ name: `${RUN}-audit`, viaImport: true });
    expect(logs[0].actorSnapshot).toMatchObject({ initials: "IT" });
  });
});

describe("a blank cell in a real file is 1, a typed 0 is 0 (end to end)", () => {
  it('(2) three rows, three meanings: blank → 1, spaces → 1, "0" → 0', async () => {
    const csv = [
      "name,quantity",
      `${RUN}-leer,`,
      `${RUN}-leerzeichen,   `,
      `${RUN}-nullwert,0`,
    ].join("\n");
    const { valid, invalid } = rowsFrom(csv);
    expect(invalid).toEqual([]);

    const { items } = await bulkCreateStock(actor, valid);
    itemIds.push(...items.map((i) => i.id));
    expect(items.map((i) => i.quantity)).toEqual([1, 1, 0]);

    // Named rows, not a prefix — the three names share no common prefix past
    // `${RUN}-`, and a `startsWith` filter that matched only two of the three
    // would have made this assertion pass for the wrong reason.
    const stored = await db.inventoryItem.findMany({
      where: { name: { in: items.map((i) => i.name) } },
    });
    expect(stored).toHaveLength(3);
    expect(stored.map((r) => r.quantity).sort()).toEqual([0, 1, 1]);
  });
});

describe("all-or-nothing, and the refusal names the row", () => {
  it("(3) a bad row in the middle aborts the WHOLE file: no item survives, not even the good ones", async () => {
    // The three good rows are inserted before the bad one is reached, so this is
    // the test that distinguishes "atomic" from "inserts what it can": the rows
    // already written at the moment of the refusal must roll back.
    const csv = [
      "name,quantity,locationId",
      `${RUN}-gut1,1,${locationId}`,
      `${RUN}-gut2,2,${locationId}`,
      `${RUN}-kaputt,3,gibt-es-nicht`,
      `${RUN}-gut3,4,${locationId}`,
    ].join("\n");
    const { valid, invalid } = rowsFrom(csv);
    expect(
      invalid,
      "an unknown locationId is a schema-valid row; the database is the judge",
    ).toEqual([]);

    let caught: unknown;
    try {
      await bulkCreateStock(actor, valid);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const message = (caught as ValidationError).formErrors.join(" ");
    // The refusal NAMES the row — the line number, and the offending field.
    expect(message).toContain("Zeile 4");
    expect(message).toContain("locationId");

    // Nothing. Not the good rows, not the bad one.
    expect(await countRows(`${RUN}-gut`)).toBe(0);
    expect(await countRows(`${RUN}-kaputt`)).toBe(0);
    // …and no audit row either: an aborted file is not an event. The
    // audit rows of the two already-inserted rows were inside the same transaction.
    const orphans = await db.activityLog.findMany({
      where: {
        entityType: "inventory-item",
        data: { path: ["name"], string_contains: `${RUN}-gut` },
      },
    });
    expect(orphans).toEqual([]);
  });

  it("(3) a row the schema refuses is reported by previewCsv with its line, before anything is written", async () => {
    const { valid, invalid } = rowsFrom(
      ["name,quantity", `${RUN}-ok,1`, `,5`, `${RUN}-auch-ok,2`].join("\n"),
    );
    expect(invalid).toHaveLength(1);
    expect(invalid[0].line).toBe(3);
    expect(invalid[0].messages.join(" ")).toContain("Name");
    // The route refuses the file outright, so the valid rows are
    // never offered to the domain.
    expect(valid).toHaveLength(2);
    expect(await countRows(`${RUN}-ok`)).toBe(0);
  });
});

describe("a duplicate is a row error, and a blank is not a duplicate", () => {
  it("(4) a sku repeated INSIDE the file is refused, naming both lines, and writes nothing", async () => {
    const csv = [
      "name,sku",
      `${RUN}-doppelt-a,${RUN}-DOPPELT`,
      `${RUN}-doppelt-b,${RUN}-DOPPELT`,
    ].join("\n");
    let caught: unknown;
    try {
      await importCsv(csv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const message = (caught as ValidationError).formErrors.join(" ");
    expect(message).toContain("Zeile 3");
    expect(message).toContain("Zeile 2");
    expect(message).toContain(`${RUN}-DOPPELT`);
    // The whole file is refused — including the first row, which was perfectly
    // legal on its own. That is what "not a partial insert" means.
    expect(await countRows(`${RUN}-doppelt`)).toBe(0);
  });

  it("(4) a serial repeated inside the file is refused too, and the message says which key", async () => {
    let caught: unknown;
    try {
      await importCsv(
        ["name,serial", `${RUN}-ser-a,${RUN}-S-DOPPELT`, `${RUN}-ser-b,${RUN}-S-DOPPELT`].join(
          "\n",
        ),
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as ValidationError).formErrors.join(" ")).toContain("Seriennummer");
    expect(await countRows(`${RUN}-ser-`)).toBe(0);
  });

  it("(4) a sku already in the DATABASE is refused by the constraint, and the earlier rows roll back", async () => {
    const existing = await createStockItem(
      actor,
      stockCreateSchema.parse({ name: `${RUN}-vorhanden`, sku: `${RUN}-GENOMMEN` }),
    );
    itemIds.push(existing.id);

    const csv = ["name,sku", `${RUN}-neu-1,${RUN}-FRISCH`, `${RUN}-neu-2,${RUN}-GENOMMEN`].join(
      "\n",
    );
    let caught: unknown;
    try {
      await importCsv(csv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const message = (caught as ValidationError).formErrors.join(" ");
    expect(message).toContain("Zeile 3");
    expect(message).toContain("sku");
    // The row that was fine rolled back with the file.
    expect(await countRows(`${RUN}-neu-`)).toBe(0);
    // The pre-existing item is untouched, and its own single audit row is not a
    // casualty of someone else's import.
    expect(await db.inventoryItem.findUnique({ where: { id: existing.id } })).not.toBeNull();
  });

  it("(4) two BLANK skus are NOT a duplicate — loose stock is the ordinary case", async () => {
    // 🔴 The line that would have been broken by a pre-flight duplicate check that
    // compared resolved values without skipping `undefined`. Both cells become
    // NULL, and the unique index keeps NULLs distinct — so this file is legal and must
    // import. A check that treated "" as a duplicate would refuse a perfectly valid
    // sheet with a message claiming a duplicate that does not exist.
    const csv = ["name,sku", `${RUN}-locker1,`, `${RUN}-locker2,`].join("\n");
    const { valid, invalid } = rowsFrom(csv);
    expect(invalid).toEqual([]);

    const { created, items } = await bulkCreateStock(actor, valid);
    itemIds.push(...items.map((i) => i.id));
    expect(created).toBe(2);
    expect(items.every((i) => i.sku === null)).toBe(true);
    expect(await countRows(`${RUN}-locker`)).toBe(2);

    // The same for a blank serial, and blank on BOTH keys at once.
    const both = await importCsv(["name,sku,serial", `${RUN}-nackt, , `].join("\n"));
    itemIds.push(both.items[0].id);
    expect(both.items[0].sku).toBeNull();
    expect(both.items[0].serial).toBeNull();
  });

  it("(4) the same sku on two DIFFERENT fields is not a duplicate", async () => {
    // `sku` and `serial` are two independent unique columns, so a row whose sku
    // equals another row's serial is legal. A check that keyed on the *value* alone
    // would refuse it.
    const csv = [
      "name,sku,serial",
      `${RUN}-kreuz-a,${RUN}-KREUZ,`,
      `${RUN}-kreuz-b,,${RUN}-KREUZ`,
    ].join("\n");
    const { created } = await importCsv(csv);
    expect(created).toBe(2);
  });
});
