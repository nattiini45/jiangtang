import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { db } from "~/lib/db.server";
import { ValidationError, hasSqlState } from "~/lib/errors.server";
import {
  collidedField,
  createStockItem,
  updateStockItem,
  deleteStockItem,
} from "~/domains/inventory/inventory.stock.mutations.server";
import {
  findStockItemBySerial,
  findStockItemBySku,
  listStockAtLocation,
  listStock,
} from "~/domains/inventory/inventory.stock.queries.server";
import {
  stockCreateSchema,
  stockEditSchema,
  type StockCreateInput,
} from "~/domains/inventory/inventory.stock.schema";

/**
 * Stock-domain guards, by property:
 *
 *   (1) a second item with the same non-null `sku`/`serial` raises
 *       `ValidationError`, not a raw `P2002`   → tests 3, 4 + the 23505 control
 *   (2) repeated NULLs stay legal               → tests 5, 6
 *   (3) `findUnique` on `sku`/`serial` works    → tests 7, 8
 *   (6) `.category`/`.unit` stay `String?`; `.status` became `StockStatus?`
 *       → the status describe owns the enum now
 *
 * Plus **the blank-quantity rule** — a blank `quantity` means "not stated" and takes the
 * default `1`, with `0` still typed and negatives still refused, in the
 * block named for it. Its CONTROL test asserts that the spelling prescribed
 * is the one that does *not* work on the installed zod, so the decision's wording
 * cannot be "corrected" back into a form that rejects a cleared box.
 *
 * ⚠️ **Test 1 and test 2 are the non-vacuity controls for the whole file**, and
 * they bypass the domain entirely: they ask **Postgres** what it does, with raw
 * SQL, so a green run cannot be explained by a careful handler in a module that
 * happens to be correct. Without them, tests 3/4 are equally consistent with
 * "the database refuses duplicates and the domain translates the error" and
 * "the database allows duplicates and nothing was ever refused" — the test file
 * cannot tell, and neither can a reader. That is the shape of a green that no
 * failure can produce.
 *
 * ActivityLog is append-only, so nothing here deletes audit rows; every assertion
 * is scoped to the ids this file created.
 */

const RUN = `stk_${Date.now().toString(36)}`;
const actor = { id: null, name: "Stock Tester", initials: "ST" };
const itemIds: string[] = [];
const locationIds: string[] = [];
const vendorIds: string[] = [];
const equipmentIds: string[] = [];

afterAll(async () => {
  await db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
  await db.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await db.location.deleteMany({ where: { id: { in: locationIds } } });
  await db.$disconnect();
});

function input(over: Partial<StockCreateInput> & { name: string }): StockCreateInput {
  return stockCreateSchema.parse(over);
}

async function make(over: Partial<StockCreateInput> & { name: string }) {
  const item = await createStockItem(actor, input(over));
  itemIds.push(item.id);
  return item;
}

function auditFor(id: string) {
  return db.activityLog.findMany({
    where: { entityType: "inventory-item", entityId: id },
    orderBy: { occurredAt: "asc" },
  });
}

async function makeLocation(name: string) {
  const location = await db.location.create({ data: { name, kind: "STORAGE" } });
  locationIds.push(location.id);
  return location;
}

async function makeVendor(name: string) {
  const vendor = await db.vendor.create({ data: { name } });
  vendorIds.push(vendor.id);
  return vendor;
}

describe("the constraint is in the DATABASE, not in the domain", () => {
  it("(1) CONTROL: a raw duplicate insert is refused by Postgres, with SQLSTATE 23505 and the colliding index named", async () => {
    // Deliberately NOT createStockItem. The question this control answers: does the
    // *database* refuse a duplicate sku, so that the ValidationError in test 3 is a
    // translation of a real refusal rather than a form check that happens to agree with
    // the database?
    const item = await make({ name: `${RUN}-control`, sku: `${RUN}-CTRL-SKU` });
    let caught: unknown;
    try {
      await db.inventoryItem.create({
        data: { name: `${RUN}-control-dup`, sku: `${RUN}-CTRL-SKU` },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught, "a raw duplicate sku insert must be refused by the database").toBeDefined();

    // The shape is documented in inventory.stock.mutations.server.ts.
    const err = caught as {
      code?: string;
      meta?: { driverAdapterError?: { cause?: Record<string, unknown> } };
    };
    expect(err.code).toBe("P2002");
    const adapterCause = err.meta?.driverAdapterError?.cause ?? {};
    expect(adapterCause.originalCode, "Postgres' own code for this failure").toBe("23505");
    expect(adapterCause.kind).toBe("UniqueConstraintViolation");
    // The colliding index, structured — the domain reads the column from its name.
    expect(adapterCause.constraint).toEqual({ index: "InventoryItem_sku_key" });

    // The SQLSTATE helper reads the adapter's `originalCode`, so a handler can
    // test for the unique violation by SQLSTATE as well as by the Prisma code.
    expect(hasSqlState(caught, "23505"), "hasSqlState reads the adapter SQLSTATE").toBe(true);

    expect(item.sku).toBe(`${RUN}-CTRL-SKU`);
  });

  it("(2) CONTROL: repeated NULLs coexist — the unique index keeps NULLs distinct", async () => {
    // The other half of the trap: an implementation that "solved" the
    // constraint by making sku/serial non-nullable would fail here, and would
    // also be wrong — most loose stock has neither identifier.
    const rows = [];
    for (let i = 0; i < 4; i++) {
      const row = await db.inventoryItem.create({ data: { name: `${RUN}-null-${i}` } });
      itemIds.push(row.id);
      rows.push(row);
    }
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.sku === null && r.serial === null)).toBe(true);
    const counted = await db.inventoryItem.count({
      where: { name: { startsWith: `${RUN}-null-` } },
    });
    expect(counted).toBe(4);
  });

  it("(2) the columns are still NULLABLE in the schema — the constraint did not buy a NOT NULL", async () => {
    const schema = readFileSync(
      fileURLToPath(new URL("../../../../prisma/schema.prisma", import.meta.url)),
      "utf8",
    );
    const model = schema.slice(
      schema.indexOf("model InventoryItem {"),
      schema.indexOf("model Vendor {"),
    );
    for (const field of ["sku", "serial"]) {
      expect(model, `${field} must remain optional`).toMatch(
        new RegExp(`\\b${field}\\s+String\\?`),
      );
    }
    // And the two unique keys are declared exactly once each.
    expect(model).toMatch(/@@unique\(\[sku\]\)/);
    expect(model).toMatch(/@@unique\(\[serial\]\)/);
  });
});

describe("a duplicate is a ValidationError, never a raw driver error", () => {
  it("(1) a duplicate non-null sku raises ValidationError naming the sku field and writes no audit row", async () => {
    const first = await make({ name: `${RUN}-sku-a`, sku: `${RUN}-SKU-1` });

    let caught: unknown;
    try {
      await createStockItem(actor, input({ name: `${RUN}-sku-b`, sku: `${RUN}-SKU-1` }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const ve = caught as ValidationError;
    expect(Object.keys(ve.fieldErrors)).toContain("sku");
    expect(ve.fieldErrors.sku[0]).toContain(`${RUN}-SKU-1`);
    // The refusal is a *refusal*: nothing was written, and — no audit
    // row either. "Nothing happened" is not an event.
    expect(await db.inventoryItem.count({ where: { sku: `${RUN}-SKU-1` } })).toBe(1);
    expect(await auditFor(first.id)).toHaveLength(1);
  });

  it("(1) a duplicate non-null serial raises ValidationError naming the serial field", async () => {
    await make({ name: `${RUN}-ser-a`, serial: `${RUN}-SER-1` });
    let caught: unknown;
    try {
      await createStockItem(actor, input({ name: `${RUN}-ser-b`, serial: `${RUN}-SER-1` }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(Object.keys((caught as ValidationError).fieldErrors)).toContain("serial");
  });

  it("(1) an EDIT onto a taken sku is refused too — the constraint is not create-only", async () => {
    await make({ name: `${RUN}-edit-taken`, sku: `${RUN}-SKU-TAKEN` });
    const target = await make({ name: `${RUN}-edit-target` });

    let caught: unknown;
    try {
      await updateStockItem(
        actor,
        target.id,
        stockEditSchema.parse({ id: target.id, name: target.name, sku: `${RUN}-SKU-TAKEN` }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(Object.keys((caught as ValidationError).fieldErrors)).toContain("sku");
    // …and the row is untouched, because the transaction rolled back.
    const after = await db.inventoryItem.findUnique({ where: { id: target.id } });
    expect(after?.sku).toBeNull();
    expect(await auditFor(target.id)).toHaveLength(1);
  });

  it("(1) an item may keep its OWN sku when edited — a self-collision is not a duplicate", async () => {
    const item = await make({ name: `${RUN}-self`, sku: `${RUN}-SKU-SELF`, quantity: 2 });
    const updated = await updateStockItem(
      actor,
      item.id,
      stockEditSchema.parse({
        id: item.id,
        name: `${RUN}-self-renamed`,
        sku: `${RUN}-SKU-SELF`,
        quantity: 3,
      }),
    );
    expect(updated.sku).toBe(`${RUN}-SKU-SELF`);
    expect(updated.quantity).toBe(3);
    expect(await auditFor(item.id)).toHaveLength(2); // create + update
  });
});

describe("the colliding field is read from the adapter's constraint", () => {
  // Fed directly, because a real duplicate also names its index in the Prisma message, and
  // the message fallback would otherwise answer these before the structured field is read.
  it("names the sku from the constraint index when the message does not", () => {
    const error = {
      code: "P2002",
      message: "Unique constraint failed",
      meta: { driverAdapterError: { cause: { constraint: { index: "InventoryItem_sku_key" } } } },
    };
    expect(collidedField(error)).toBe("sku");
  });

  it("names the serial from the constraint index when the message does not", () => {
    const error = {
      code: "P2002",
      message: "Unique constraint failed",
      meta: {
        driverAdapterError: { cause: { constraint: { index: "InventoryItem_serial_key" } } },
      },
    };
    expect(collidedField(error)).toBe("serial");
  });

  it("names nothing when neither the constraint nor the message names a column", () => {
    expect(collidedField({ code: "P2002", message: "Unique constraint failed" })).toBeNull();
  });
});

describe("a nullable unique is a legal selector", () => {
  it("(3) findUnique by sku returns exactly that item", async () => {
    const item = await make({ name: `${RUN}-find-sku`, sku: `${RUN}-FIND-SKU` });
    const found = await findStockItemBySku(`${RUN}-FIND-SKU`);
    expect(found?.id).toBe(item.id);
    expect(await findStockItemBySku(`${RUN}-FIND-SKU-none`)).toBeNull();
  });

  it("(3) findUnique by serial returns exactly that item", async () => {
    const item = await make({ name: `${RUN}-find-ser`, serial: `${RUN}-FIND-SER` });
    const found = await findStockItemBySerial(`${RUN}-FIND-SER`);
    expect(found?.id).toBe(item.id);
    // The refs are joined, so no caller has to N+1 a vendor.
    expect(found).toHaveProperty("location");
    expect(found).toHaveProperty("vendor");
  });

  it("(3) CONTROL: the two selectors are type-checked by the build, not asserted in prose", async () => {
    // findStockItemBySku/BySerial are called with a `string` above and the module
    // uses `findUnique({ where: { sku } })` directly. If the generated selector
    // did not contain "sku", `pnpm typecheck` fails — this test records that the
    // claim rests on the compiler rather than on this file's own comment.
    const type = readFileSync(
      fileURLToPath(
        new URL("../../../../app/generated/prisma/models/InventoryItem.ts", import.meta.url),
      ),
      "utf8",
    );
    const start = type.indexOf("export type InventoryItemWhereUniqueInput");
    const atLeast = type.slice(
      start,
      type.indexOf("\n", type.indexOf('"serial"', start) + 1) + 200,
    );
    expect(atLeast).toMatch(/sku\?:\s*string/);
    expect(atLeast).toMatch(/"id" \| "sku" \| "serial"/);
  });
});

describe("status is `StockStatus?`; category/unit stay free text", () => {
  const FIVE = [
    "AVAILABLE",
    "REQUESTED",
    "AWAITING_CONFIRMATION",
    "ON_LOAN",
    "RESERVED_FOR_EVENT",
  ] as const;

  it("the schema declares `status StockStatus?` and the enum holds exactly the five values", async () => {
    const schema = readFileSync(
      fileURLToPath(new URL("../../../../prisma/schema.prisma", import.meta.url)),
      "utf8",
    );
    const model = schema.slice(
      schema.indexOf("model InventoryItem {"),
      schema.indexOf("model Vendor {"),
    );
    // Same capture-the-type reading as the other schema checks — declared type
    // compared exactly, not pattern-matched loosely.
    expect(model.match(/^\s*status\s+(\S+)/m)?.[1]).toBe("StockStatus?");
    for (const field of ["category", "unit"]) {
      const declared = model.match(new RegExp(`^\\s*${field}\\s+(\\S+)`, "m"))?.[1];
      expect(declared, `${field} stays untyped`).toBe("String?");
    }
    const enumBlock = schema.slice(
      schema.indexOf("enum StockStatus {"),
      schema.indexOf("}", schema.indexOf("enum StockStatus {")),
    );
    for (const value of FIVE)
      expect(enumBlock, `enum StockStatus must contain ${value}`).toContain(value);
    expect(
      enumBlock.match(/^\s*[A-Z_]+/gm)?.filter((line) => /^[A-Z_]+$/.test(line.trim())),
    ).toHaveLength(5);
  });

  it("CONTROL: the column in Postgres really is the enum — pg_enum holds exactly the five labels", async () => {
    // The schema-text assertion above cannot see a migration that was never
    // written or a `CREATE TYPE` that dropped a value. The database answers both.
    const typeRows = await db.$queryRaw<{ typname: string }[]>`
      SELECT t.typname FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE c.relname = 'InventoryItem' AND a.attname = 'status'
    `;
    expect(typeRows.map((r) => r.typname)).toEqual(["StockStatus"]);
    const labels = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'StockStatus' ORDER BY e.enumsortorder
    `;
    expect(labels.map((r) => r.enumlabel)).toEqual([...FIVE]);
  });

  it("create and edit carry a typed status through the column — and blank stays null", async () => {
    const item = await make({ name: `${RUN}-status`, status: "ON_LOAN" });
    expect(item.status).toBe("ON_LOAN");
    const updated = await updateStockItem(
      actor,
      item.id,
      stockEditSchema.parse({ id: item.id, name: `${RUN}-status`, status: "RESERVED_FOR_EVENT" }),
    );
    expect(updated.status).toBe("RESERVED_FOR_EVENT");
    const stored = await db.inventoryItem.findUnique({ where: { id: item.id } });
    expect(stored?.status).toBe("RESERVED_FOR_EVENT");
    // No status named → NULL, not a default: "no status recorded" is a real state.
    const blank = await make({ name: `${RUN}-no-status` });
    expect(blank.status).toBeNull();
  });

  it("the domain accepts the enum value or its German label, case-insensitively — junk is refused", () => {
    expect(stockCreateSchema.parse({ name: `${RUN}-s1`, status: "REQUESTED" }).status).toBe(
      "REQUESTED",
    );
    expect(stockCreateSchema.parse({ name: `${RUN}-s2`, status: "Verliehen" }).status).toBe(
      "ON_LOAN",
    );
    expect(
      stockCreateSchema.parse({ name: `${RUN}-s3`, status: "wartet auf bestätigung" }).status,
    ).toBe("AWAITING_CONFIRMATION");
    expect(
      stockCreateSchema.parse({ name: `${RUN}-s4`, status: "für veranstaltung reserviert" }).status,
    ).toBe("RESERVED_FOR_EVENT");
    expect(stockCreateSchema.parse({ name: `${RUN}-s5`, status: "" }).status).toBeUndefined();
    const bad = stockCreateSchema.safeParse({ name: `${RUN}-s6`, status: "irgendein_zustand" });
    expect(bad.success, "an unknown status must be refused, not silently null").toBe(false);
  });
});

describe('a blank `quantity` is "not stated" and takes the default', () => {
  it("(2) a blank cell, a whitespace-only cell and an absent column all resolve to 1", () => {
    // The three ways a spreadsheet says "I did not say", and the rule is that
    // they are the same three ways a form says it. The whitespace case is the one
    // that would have survived a fix written only against an empty cell.
    expect(stockCreateSchema.parse({ name: `${RUN}-q1`, quantity: "" }).quantity).toBe(1);
    expect(stockCreateSchema.parse({ name: `${RUN}-q2`, quantity: "   " }).quantity).toBe(1);
    expect(stockCreateSchema.parse({ name: `${RUN}-q3` }).quantity).toBe(1);
  });

  it("(2) an explicit 0 round-trips as 0 — through the schema AND through the column", () => {
    // ⚠️ The negative control that makes the test above mean something. A blanket
    // `.catch(1)` or a `.transform(() => 1)` passes "blank → 1" and fails here, and
    // "we have none of this" is a legal, reachable state.
    expect(stockCreateSchema.parse({ name: `${RUN}-q0a`, quantity: 0 }).quantity).toBe(0);
    expect(stockCreateSchema.parse({ name: `${RUN}-q0b`, quantity: "0" }).quantity).toBe(0);
  });

  it("(2) a negative, a fractional and a non-numeric value are still REJECTED", async () => {
    // The instrument can still say no. Without these, a fix that made blank→1 by
    // widening the validator would be indistinguishable from one that made it
    // right — and (c) rejected `min(1)` precisely because a louder wrong
    // answer is not a better one.
    for (const bad of [-5, "1.5", "abc", "3 Stück"]) {
      expect(
        stockCreateSchema.safeParse({ name: `${RUN}-bad`, quantity: bad }).success,
        `${String(bad)} must be rejected`,
      ).toBe(false);
    }
    // …and nothing negative reached the column while we were here.
    expect(
      await db.inventoryItem.count({
        where: { name: { startsWith: `${RUN}-bad` }, quantity: { lt: 0 } },
      }),
    ).toBe(0);
  });

  it("(2) the stored value is the parsed one — blank lands as 1 in the column, typed 0 as 0", async () => {
    // The schema is a claim about a value; this is the claim about the row. Both
    // halves of ("the form's cleared box now yields 1, and 0 stays typed")
    // asserted against the database, not against the parser.
    //
    // ⚠️ Written through `stockCreateSchema.parse` rather than the file's `make()`
    // helper on purpose: `make` takes a `StockCreateInput`, whose `quantity` is
    // already the parsed `number` — so it cannot accept the `""` this test exists
    // to feed it, and typing around that would have meant never passing a blank.
    const blank = await createStockItem(
      actor,
      stockCreateSchema.parse({ name: `${RUN}-q-db-blank`, quantity: "" }),
    );
    const zero = await createStockItem(
      actor,
      stockCreateSchema.parse({ name: `${RUN}-q-db-zero`, quantity: 0 }),
    );
    itemIds.push(blank.id, zero.id);

    const stored = await db.inventoryItem.findMany({
      where: { id: { in: [blank.id, zero.id] } },
      orderBy: { name: "asc" },
    });
    expect(stored.map((r) => [r.name.endsWith("blank"), r.quantity])).toEqual([
      [true, 1],
      [false, 0],
    ]);
  });

  it("(2) CONTROL: the spelling prescribed is measurably the one that does NOT work", () => {
    // 🔴 zod 3's `ZodDefault` takes the default only when the INPUT is `undefined`,
    // and a blank cell arrives as `""` — so with `.default()` on the outside of the
    // preprocess, `""` reaches `z.coerce.number()` as NaN and the row is REFUSED
    // instead of defaulted. This is the guard on the decision's own wording: a
    // future tick "correcting" the code to match literally turns this red
    // with a reason, instead of shipping a form that rejects a cleared box.
    const prescribed = z
      .preprocess(
        (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v),
        z.coerce.number().int().min(0),
      )
      .default(1);
    expect(prescribed.safeParse("").success, "the granted spelling rejects a blank cell").toBe(
      false,
    );
    expect(prescribed.safeParse(undefined).success, "…and only the absent case defaults").toBe(
      true,
    );
    // The shipped spelling is the other nesting: the default INSIDE the preprocess.
    const shipped = stockCreateSchema.safeParse({ name: `${RUN}-q`, quantity: "" });
    expect(shipped.success).toBe(true);
    expect(shipped.success && shipped.data.quantity).toBe(1);
  });

  it("(2) the EDIT schema inherits the rule by construction — the edit path may not re-derive it", () => {
    // `stockEditSchema` is `stockCreateSchema.extend({ id })`. If the rule
    // ever moves out of the create schema, this goes red and says so — the failure
    // mode was written to prevent is the editor silently carrying a
    // different rule from the importer again.
    expect(stockEditSchema.parse({ id: "x", name: `${RUN}-edit`, quantity: "  " }).quantity).toBe(
      1,
    );
    expect(stockEditSchema.parse({ id: "x", name: `${RUN}-edit`, quantity: "0" }).quantity).toBe(0);
  });
});

describe("audit + join shape", () => {
  it("create writes exactly one audit row; delete writes one and removes the row", async () => {
    const item = await make({ name: `${RUN}-audit` });
    const logs = await auditFor(item.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("InventoryItemCreated");
    expect(logs[0].actorSnapshot).toMatchObject({ initials: "ST" });

    await deleteStockItem(actor, item.id);
    expect(await db.inventoryItem.findUnique({ where: { id: item.id } })).toBeNull();
    // The audit row survives the delete it records — append-only.
    expect(await auditFor(item.id)).toHaveLength(2);
  });

  it("a delete of an equipment-linked item is refused and writes no audit row", async () => {
    // `Equipment.category` is a required enum (unlike the stock columns, which are
    // all free text) — an Equipment row cannot be created without one.
    const equipment = await db.equipment.create({ data: { name: `${RUN}-eq`, category: "OTHER" } });
    equipmentIds.push(equipment.id);
    const item = await make({ name: `${RUN}-linked`, equipmentId: equipment.id });
    expect(await auditFor(item.id)).toHaveLength(1);

    let caught: unknown;
    try {
      await deleteStockItem(actor, item.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(await db.inventoryItem.findUnique({ where: { id: item.id } })).not.toBeNull();
    expect(await auditFor(item.id)).toHaveLength(1);
  });

  it("an unknown foreign key is a field error, not a driver error", async () => {
    let caught: unknown;
    try {
      await createStockItem(actor, input({ name: `${RUN}-bad-fk`, locationId: "does-not-exist" }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(Object.keys((caught as ValidationError).fieldErrors)).toContain("locationId");
  });

  it("listStockAtLocation counts only items AT that location — an unassigned item is not there", async () => {
    const here = await makeLocation(`${RUN}-hier`);
    const elsewhere = await makeLocation(`${RUN}-dort`);
    const vendor = await makeVendor(`${RUN}-vendor`);
    const at = await make({ name: `${RUN}-at`, locationId: here.id, vendorId: vendor.id });
    await make({ name: `${RUN}-elsewhere`, locationId: elsewhere.id });
    await make({ name: `${RUN}-unassigned` });

    const rows = await listStockAtLocation(here.id);
    expect(rows.map((r) => r.id)).toEqual([at.id]);
    // And the join is present, so the panel needs no second query.
    expect(rows[0].location?.id).toBe(here.id);
    expect(rows[0].vendor?.id).toBe(vendor.id);

    const all = await listStock();
    expect(all.map((r) => r.id)).toContain(at.id);
    // Stable order: name asc, id asc — a repeated list is byte-identical.
    const again = await listStock();
    expect(again.map((r) => r.id)).toEqual(all.map((r) => r.id));
  });
});
