import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { messages } from "~/i18n";
import { db } from "~/lib/db.server";
import { ValidationError, hasSqlState } from "~/lib/errors.server";
import { txWithAudit } from "~/lib/audit.server";
import { ENTITY_TYPE, listEntityHistory } from "~/domains/tickets/tickets.history.server";
import {
  createStockItem,
  deleteStockItem,
  isEquipmentFkViolation,
  HARMONY_ACTION,
  linkStockItemToEquipment,
  unlinkStockItemFromEquipment,
} from "~/domains/inventory/inventory.stock.mutations.server";
import {
  getEquipmentForStockItem,
  listStockForEquipment,
} from "~/domains/inventory/inventory.harmony.queries.server";
import {
  stockCreateSchema,
  type StockCreateInput,
} from "~/domains/inventory/inventory.stock.schema";

/**
 * The harmony link's guards, one per acceptance criterion:
 *
 *   (1) a link and an unlink each append TWO rows, one per side, each naming
 *       the counterpart — and the shipped equipment feed can see the link  → tests 1–5
 *   (2) the link reads both ways from ONE module, which writes nothing     → tests 6–8
 *   (3a) the link write cannot dangle: a bad `equipmentId` is a field error → tests 9–12
 *   (3b) the `Restrict` FK refuses to delete a referenced parent, proven at
 *       the SQL layer, with the control in the OPPOSITE direction          → tests 13–14
 *   (3c) unlinked, the stock row goes and the Equipment stays             → tests 15–16
 *   (4) the module is `app/domains/inventory/inventory.*`, not a new
 *       `app/domains/stock/`                                              → test 17
 *
 * ⚠️ **The controls are the file.** Every assertion here has a paired arm that
 * could only pass if the thing under test is real, because a query that never
 * matches is indistinguishable from a correct negative:
 *
 *   - test 3 is test 1's control — the *same* `listEntityHistory` call against a
 *     sibling entity that was never linked, which must return nothing. It cannot
 *     be "the same call after an unlink, returning nothing": the log is
 *     append-only, so the link row outlives the link on purpose.
 *   - test 7 is test 6's control — the unlinked side returns `null` / `[]`.
 *   - test 14 is test 13's control — the *identical* `DELETE` statement
 *     succeeds once the link is gone, so test 13's refusal is the FK and not
 *     "DELETE never works here".
 *   - test 10 is test 9's control — it asks the database what a real dangling
 *     write raises, so the `ValidationError` in test 9 is a translation of a
 *     refusal that genuinely happens rather than a pre-check inventing one.
 *
 * ⚠️ **Test 11 stages the race that `isEquipmentFkViolation` exists to close, and
 * it does it by hand rather than through the domain call.** A parent deleted
 * between the handler's pre-check and its UPDATE cannot be produced from *inside*
 * that call, so the test opens its own `txWithAudit` (the sanctioned seam — a raw
 * transaction call is banned in this whole directory by `guards.sh` #2, and that
 * check has no test-file exemption, so not even this sentence may name it) and
 * interleaves
 * the parent's deletion from a second pooled connection between the two
 * statements the handler really issues. The error that comes back is the one the
 * backstop must recognise.
 *
 * ActivityLog is append-only, so nothing here deletes audit rows; every assertion
 * is scoped to the ids this file created.
 */

/** Thrown to roll a `txWithAudit` body back without asserting on the rollback. */
class Rollback extends Error {}

const RUN = `harm_${Date.now().toString(36)}`;
const actor = { id: null, name: "Harmony Tester", initials: "HT" };
const itemIds: string[] = [];
const equipmentIds: string[] = [];

afterAll(async () => {
  await db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
  await db.$disconnect();
});

async function make(over: Partial<StockCreateInput> & { name: string }) {
  const item = await createStockItem(actor, stockCreateSchema.parse(over));
  itemIds.push(item.id);
  return item;
}

async function makeEquipment(name: string) {
  // `Equipment.category` is a required enum, so an Equipment row cannot be
  // created without one.
  const eq = await db.equipment.create({
    data: { name, assetTag: `${name}-tag`, category: "OTHER" },
  });
  equipmentIds.push(eq.id);
  return eq;
}

function itemHistory(id: string) {
  return db.activityLog.findMany({
    where: { entityType: "inventory-item", entityId: id },
    orderBy: { occurredAt: "asc" },
  });
}

describe("one row per side, and the shipped equipment feed can see it", () => {
  it("(1) a link appends TWO rows: one under the stock item, one under the equipment, each naming the counterpart", async () => {
    const item = await make({ name: `${RUN}-link` });
    const eq = await makeEquipment(`${RUN}-link-eq`);

    expect(item.equipmentId).toBeNull();
    const linked = await linkStockItemToEquipment(actor, item.id, eq.id);
    expect(linked.equipmentId).toBe(eq.id);

    const onItem = await itemHistory(item.id);
    const onEquipment = await db.activityLog.findMany({
      where: { entityType: "equipment", entityId: eq.id },
      orderBy: { occurredAt: "asc" },
    });

    // The item's history: the create row this file made, plus exactly one link row.
    const linkRows = onItem.filter((r) => r.action === HARMONY_ACTION.linked);
    expect(linkRows, "the stock side must carry its own row").toHaveLength(1);
    expect(linkRows[0].entityType).toBe("inventory-item");
    expect(linkRows[0].entityId).toBe(item.id);
    // …and it must NAME the counterpart, not merely imply it: `data` is the only
    // place the second id can live, so a row without it names nothing.
    expect(linkRows[0].data).toMatchObject({ equipmentId: eq.id });

    // The equipment's history — the half a one-row implementation cannot produce.
    const equipmentRows = onEquipment.filter((r) => r.action === HARMONY_ACTION.linked);
    expect(equipmentRows, "the equipment side must carry its own row").toHaveLength(1);
    expect(equipmentRows[0].entityId).toBe(eq.id);
    expect(equipmentRows[0].data).toMatchObject({ stockItemId: item.id });

    // And the actions are the same on both sides, which is what keeps the label
    // budget at two (see HARMONY_ACTION).
    expect(linkRows[0].action).toBe(equipmentRows[0].action);
  });

  it("(1) the SHIPPED equipment page's reader returns the link — this is why two rows exist", async () => {
    const item = await make({ name: `${RUN}-feed` });
    const eq = await makeEquipment(`${RUN}-feed-eq`);
    await linkStockItemToEquipment(actor, item.id, eq.id);

    // Exactly the call `app/routes/_desktop.inventory.$id/route.tsx:58` makes.
    const feed = await listEntityHistory(ENTITY_TYPE.equipment, eq.id, 20);
    const rows = feed.filter((r) => r.action === HARMONY_ACTION.linked);
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ stockItemId: item.id });
    // The actor travelled with it, so the feed can show who linked it.
    expect(rows[0].actorSnapshot).toMatchObject({ initials: "HT" });
  });

  it("(1) CONTROL: the same reader returns the link row for the LINKED equipment and none for an untouched one", async () => {
    // 🔴 **The control is scoped to the ENTITY, not to the link's existence — and
    // that is not a weakening.** `ActivityLog` is append-only, so the link row
    // legitimately SURVIVES the unlink that ends the link: erasing it would be the
    // one thing an append-only log may not do. A control phrased "unlink, then the
    // history returns nothing" therefore cannot be satisfied by ANY correct
    // implementation, and would have passed only for a writer that mutated history.
    //
    // What can go wrong in the other direction — and what this arm catches — is a
    // reader that is NOT scoped to its entity pair: a filter that ignored
    // `entityId`, or matched every row this run wrote, would return the link row
    // for a device that was never linked. So the negative arm is a *sibling
    // entity*, read through the identical call.
    const item = await make({ name: `${RUN}-ctl` });
    const eq = await makeEquipment(`${RUN}-ctl-eq`);
    const untouched = await makeEquipment(`${RUN}-ctl-untouched`);
    await linkStockItemToEquipment(actor, item.id, eq.id);

    const linked = await listEntityHistory(ENTITY_TYPE.equipment, eq.id, 20);
    expect(linked.filter((r) => r.action === HARMONY_ACTION.linked)).toHaveLength(1);
    // The control: same reader, same action, a device this run never linked.
    const other = await listEntityHistory(ENTITY_TYPE.equipment, untouched.id, 20);
    expect(
      other.filter((r) => r.action === HARMONY_ACTION.linked),
      "the feed must be scoped to its entity pair",
    ).toHaveLength(0);

    await unlinkStockItemFromEquipment(actor, item.id);
    // The unlink is recorded on both sides — two rows again…
    expect(
      (await listEntityHistory(ENTITY_TYPE.equipment, eq.id, 20)).filter(
        (r) => r.action === HARMONY_ACTION.unlinked,
      ),
    ).toHaveLength(1);
    expect(
      (await itemHistory(item.id)).filter((r) => r.action === HARMONY_ACTION.unlinked),
    ).toHaveLength(1);
    // …and the original link row is STILL THERE, which is the append-only
    // invariant made visible: a reader shows that these two things happened, in
    // order, and neither of them was rewritten.
    const after = await listEntityHistory(ENTITY_TYPE.equipment, eq.id, 20);
    expect(after.filter((r) => r.action === HARMONY_ACTION.linked)).toHaveLength(1);
    expect(after[0].action, "newest first").toBe(HARMONY_ACTION.unlinked);
  });

  it("(1) a refused link writes NO audit row on either side (nothing happened is not an event)", async () => {
    const item = await make({ name: `${RUN}-refused` });
    await makeEquipment(`${RUN}-refused-eq`);

    let caught: unknown;
    try {
      await linkStockItemToEquipment(actor, item.id, "no-such-equipment");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);

    // The equipment side is the one a half-written transaction would dirty: a
    // row naming an equipment id that does not exist is a permanent lie.
    const ghosts = await db.activityLog.count({
      where: { entityType: "equipment", entityId: "no-such-equipment" },
    });
    expect(ghosts).toBe(0);
    expect(await itemHistory(item.id)).toHaveLength(1); // the create row only
    expect((await getEquipmentForStockItem(item.id))?.id ?? null).toBeNull();
  });

  it("(1) both actions carry a German label in the shipped catalog — driven by the names this module writes", async () => {
    // The feed renders `actionLabel(locale, e.action)`, so an unlabelled
    // action reaches a user as `EquipmentStockLinked`. The labels are read from
    // the German catalog and compared against `HARMONY_ACTION`, so renaming
    // an action cannot leave the label behind.
    const catalog = messages("de") as Record<string, string>;
    const labels = new Map<string, string>();
    for (const [key, value] of Object.entries(catalog)) {
      if (key.startsWith("history.action.")) labels.set(key.slice("history.action.".length), value);
    }
    // CONTROL: a known key proves the extraction read the catalog rather than
    // returning an empty set that satisfies every "is it there" check.
    expect(labels.get("EquipmentRetired")).toBe("Gerät ausgemustert");

    for (const action of Object.values(HARMONY_ACTION)) {
      expect(
        labels.has(action),
        `the history catalog is missing ${action} — it would render as a raw identifier`,
      ).toBe(true);
      expect(labels.get(action), "labels are German sentences, not identifiers").toMatch(
        /^[A-ZÄÖÜ]/,
      );
    }
    // …and the two new labels are distinct, so a copy-paste cannot pass as two.
    expect(labels.get(HARMONY_ACTION.linked)).not.toBe(labels.get(HARMONY_ACTION.unlinked));
  });
});

describe("both directions, one module, no write", () => {
  it("(2) equipment → its stock items, and item → its equipment", async () => {
    const eq = await makeEquipment(`${RUN}-both-eq`);
    const other = await makeEquipment(`${RUN}-both-other`);
    const item = await make({ name: `${RUN}-both` });
    const sibling = await make({ name: `${RUN}-both-sibling` });
    await linkStockItemToEquipment(actor, item.id, eq.id);
    await linkStockItemToEquipment(actor, sibling.id, eq.id);
    const elsewhere = await make({ name: `${RUN}-both-elsewhere` });
    await linkStockItemToEquipment(actor, elsewhere.id, other.id);

    const rows = await listStockForEquipment(eq.id);
    expect(rows.map((r) => r.id).sort()).toEqual([item.id, sibling.id].sort());
    // Stable order (name, id), so a repeated read is
    // byte-identical rather than planner-dependent.
    expect(rows.map((r) => r.id)).toEqual(
      [...rows]
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1))
        .map((r) => r.id),
    );
    // The joins a stock list needs came along, so a panel needs no second query.
    expect(rows[0]).toHaveProperty("location");
    expect(rows[0]).toHaveProperty("vendor");

    const back = await getEquipmentForStockItem(item.id);
    expect(back?.id).toBe(eq.id);
    expect(back?.assetTag).toBe(`${RUN}-both-eq-tag`);
  });

  it("(2) CONTROL: an unlinked item has no equipment, and an equipment with no items has none — the readers can return 'none'", async () => {
    const loose = await make({ name: `${RUN}-loose` });
    const empty = await makeEquipment(`${RUN}-empty-eq`);

    expect(await getEquipmentForStockItem(loose.id)).toBeNull();
    expect(await listStockForEquipment(empty.id)).toEqual([]);

    // …and the round trip recovers, so the `null` was a real absence and not a
    // reader that stopped working after the first call.
    const eq = await makeEquipment(`${RUN}-rt-eq`);
    const item = await make({ name: `${RUN}-rt` });
    expect(await getEquipmentForStockItem(item.id)).toBeNull();
    await linkStockItemToEquipment(actor, item.id, eq.id);
    expect((await getEquipmentForStockItem(item.id))?.id).toBe(eq.id);
  });

  it("(2) the harmony module WRITES nothing — no mutation, and no transaction of its own", async () => {
    // The domain-ownership rule behind this guard: the link is read here
    // and written in one other file. A module that grew a `.update(` would be
    // maintaining the link from the read side, which is the cross-domain write
    // the rule bans.
    const source = readFileSync(
      fileURLToPath(new URL("../inventory.harmony.queries.server.ts", import.meta.url)),
      "utf8",
    );
    for (const verb of [
      ".create(",
      ".createMany(",
      ".update(",
      ".updateMany(",
      ".upsert(",
      ".delete(",
      ".deleteMany(",
      "$transaction",
      "$executeRaw",
      "$queryRaw",
    ]) {
      expect(source, `the read module must not contain ${verb}`).not.toContain(verb);
    }
    // CONTROL: the scan is not blind to those spellings — the writer next door
    // contains several of them, so a scanner that found nothing because it
    // matched nothing would have reported the same clean result here.
    const writer = readFileSync(
      fileURLToPath(new URL("../inventory.stock.mutations.server.ts", import.meta.url)),
      "utf8",
    );
    expect(writer).toContain(".update(");
    expect(writer).toContain("await audit({");
  });
});

describe("the link write cannot dangle", () => {
  it("(3a) a non-existent equipmentId is a field error, not a raw driver error", async () => {
    const item = await make({ name: `${RUN}-ghost` });
    let caught: unknown;
    try {
      await linkStockItemToEquipment(actor, item.id, "no-such-equipment");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const ve = caught as ValidationError;
    expect(Object.keys(ve.fieldErrors)).toContain("equipmentId");
    expect(ve.fieldErrors.equipmentId[0]).toContain("Unbekanntes Gerät");
    // No Prisma code leaked: the point of the seam is that the caller sees a 422.
    expect((caught as { code?: unknown }).code).toBeUndefined();
    // And the item is still unlinked — a refusal is not a partial write.
    expect((await db.inventoryItem.findUnique({ where: { id: item.id } }))?.equipmentId).toBeNull();
  });

  it("(3a) CONTROL: what the DATABASE raises for a dangling link, measured — and the general SQLSTATE helper cannot see it", async () => {
    // Bypasses the domain entirely, so the ValidationError above is a translation
    // of a refusal that genuinely happens.
    const item = await make({ name: `${RUN}-shape` });
    let caught: unknown;
    try {
      await db.inventoryItem.update({
        where: { id: item.id },
        data: { equipmentId: "no-such-equipment" },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught, "a dangling write must be refused by the database").toBeDefined();

    const err = caught as {
      code?: unknown;
      meta?: { driverAdapterError?: { cause?: Record<string, unknown> } };
    };
    const cause = err.meta?.driverAdapterError?.cause ?? {};
    expect(err.code).toBe("P2003");
    expect(cause.originalCode).toBe("23503");
    expect(cause.kind).toBe("ForeignKeyConstraintViolation");
    expect(cause.constraint).toMatchObject({ index: "InventoryItem_equipmentId_fkey" });

    // 🔴 THE INSTRUMENT FINDING, asserted so it cannot be re-broken: `hasSqlState`
    // walks `.cause` and compares `code`/`meta.code`, and the SQLSTATE sits two
    // levels down. A backstop written as `hasSqlState(error, "23503")` catches
    // NOTHING and lets a raw driver error reach the caller as a 500 — the same
    // hole `23505` had, arriving through the foreign-key door (that one has the
    // same shape on this stack; this is its sibling).
    expect(hasSqlState(caught, "23503"), "hasSqlState cannot reach 23503 on this stack").toBe(
      false,
    );
    expect(hasSqlState(caught, "P2003"), "the Prisma code is the handle that does work").toBe(true);
    // Which is why the domain detects it structurally.
    expect(isEquipmentFkViolation(caught)).toBe(true);
  });

  it("(3a) the race the backstop closes, staged by hand: the parent vanishes between the pre-check and the UPDATE", async () => {
    const item = await make({ name: `${RUN}-race` });
    const eq = await makeEquipment(`${RUN}-race-eq`);

    let caught: unknown;
    try {
      await txWithAudit(actor, async (tx) => {
        // 1. exactly the pre-check the handler performs — the row is there.
        expect(await tx.equipment.findUnique({ where: { id: eq.id } })).not.toBeNull();
        // 2. the parent disappears from OUTSIDE this transaction, on a second
        //    pooled connection. Nothing references it yet, so no lock blocks it.
        await db.equipment.delete({ where: { id: eq.id } });
        // 3. exactly the UPDATE the handler performs — now dangling.
        try {
          await tx.inventoryItem.update({ where: { id: item.id }, data: { equipmentId: eq.id } });
        } catch (error) {
          caught = error;
        }
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    expect(caught, "the staged interleaving must produce a real violation").toBeDefined();
    expect(isEquipmentFkViolation(caught), "the backstop must recognise the race's own error").toBe(
      true,
    );
    // CONTROL: the detector is not a blanket "any database error" check.
    expect(isEquipmentFkViolation(new Error("unrelated"))).toBe(false);
    expect(isEquipmentFkViolation(undefined)).toBe(false);
    // And the transaction rolled back, so the probe left the item unlinked.
    expect((await db.inventoryItem.findUnique({ where: { id: item.id } }))?.equipmentId).toBeNull();
  });

  it("(3a) a second link is refused — one link per item, changed by unlinking first", async () => {
    const item = await make({ name: `${RUN}-relink` });
    const eq = await makeEquipment(`${RUN}-relink-eq`);
    const other = await makeEquipment(`${RUN}-relink-other`);
    await linkStockItemToEquipment(actor, item.id, eq.id);

    const before = await itemHistory(item.id);
    for (const [target, needle] of [
      [eq.id, "bereits"],
      [other.id, "anderen Gerät"],
    ] as const) {
      let caught: unknown;
      try {
        await linkStockItemToEquipment(actor, item.id, target);
      } catch (error) {
        caught = error;
      }
      expect(
        caught,
        `re-linking to ${target === eq.id ? "the same" : "another"} device must be refused`,
      ).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).formErrors[0]).toContain(needle);
    }
    // A refusal is not an event: no row was appended by either attempt.
    expect(await itemHistory(item.id)).toHaveLength(before.length);
    // Unlink is the supported way through, and it leaves the item unlinked.
    await unlinkStockItemFromEquipment(actor, item.id);
    await linkStockItemToEquipment(actor, item.id, other.id);
    expect((await getEquipmentForStockItem(item.id))?.id).toBe(other.id);
  });

  it("(3a) an unknown stock item is a 404, and unlinking an unlinked item is a refusal", async () => {
    let caught: unknown;
    try {
      await linkStockItemToEquipment(actor, "no-such-item", "also-no-such-equipment");
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).name).toBe("NotFoundError");

    const loose = await make({ name: `${RUN}-unlink-loose` });
    let refused: unknown;
    try {
      await unlinkStockItemFromEquipment(actor, loose.id);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ValidationError);
    expect(await itemHistory(loose.id)).toHaveLength(1);
  });
});

describe("the Restrict constraint is a property of the database", () => {
  it("(3b) deleting a referenced Equipment is REFUSED by the FK, and the outcome is a value — not an error line on stderr", async () => {
    // ⚠️ Labelled a property of the CONSTRAINT, not of a route: the product has no
    // equipment delete by design ("Deletions — None"), so this
    // statement is the only one that can raise 23001. It is proved here because
    // whoever writes SQL next needs to know the link is load-bearing.
    const item = await make({ name: `${RUN}-restrict` });
    const eq = await makeEquipment(`${RUN}-restrict-eq`);
    await linkStockItemToEquipment(actor, item.id, eq.id);

    let caught: unknown;
    try {
      await db.equipment.delete({ where: { id: eq.id } });
    } catch (error) {
      caught = error;
    }
    // The outcome is RETURNED and compared, never inferred from stderr: a tool
    // that reports the same `ERROR:` line whether the exception was caught or
    // propagated cannot tell refusal from success, and so cannot fail.
    expect(caught, "the Restrict FK must refuse this delete").toBeDefined();
    expect(hasSqlState(caught, "23001"), "the refusal must be the Restrict violation").toBe(true);
    // And the parent is still there — the refusal, not a silent success.
    const survived = await db.equipment.findUnique({ where: { id: eq.id } });
    expect(survived, "a refused delete leaves the row").not.toBeNull();
    expect(survived?.assetTag).toBe(`${RUN}-restrict-eq-tag`);
  });

  it("(3b) CONTROL in the opposite direction: unlink, then the IDENTICAL delete succeeds", async () => {
    // Without this arm, test 13 is equally consistent with "the FK refuses" and
    // "DELETE on this table always fails" — the pair is what makes it a finding.
    const item = await make({ name: `${RUN}-free` });
    const eq = await makeEquipment(`${RUN}-free-eq`);
    await linkStockItemToEquipment(actor, item.id, eq.id);
    expect(hasSqlState(await tryDelete(eq.id), "23001")).toBe(true);

    await unlinkStockItemFromEquipment(actor, item.id);

    const after = await tryDelete(eq.id);
    expect(after, "the identical DELETE must succeed once the link is gone").toBeUndefined();
    expect(await db.equipment.findUnique({ where: { id: eq.id } })).toBeNull();
  });
});

describe("unlinked, the stock row goes and the Equipment stays", () => {
  it("(3c) deleting the stock row after unlinking leaves the Equipment untouched", async () => {
    const item = await make({ name: `${RUN}-gone` });
    const eq = await makeEquipment(`${RUN}-gone-eq`);
    await linkStockItemToEquipment(actor, item.id, eq.id);
    await unlinkStockItemFromEquipment(actor, item.id);

    const deleted = await deleteStockItem(actor, item.id);
    expect(deleted.id).toBe(item.id);
    expect(await db.inventoryItem.findUnique({ where: { id: item.id } })).toBeNull();

    // Every field the link could have damaged, compared one by one.
    const survivor = await db.equipment.findUnique({ where: { id: eq.id } });
    expect(survivor).not.toBeNull();
    expect(survivor?.name).toBe(`${RUN}-gone-eq`);
    expect(survivor?.assetTag).toBe(`${RUN}-gone-eq-tag`);
    expect(survivor?.category).toBe("OTHER");
    expect(survivor?.status).toBe("OPERATIONAL");
    // And it is free again: the constraint no longer applies to it.
    expect(await tryDelete(eq.id)).toBeUndefined();
  });

  it("(3c) a LINKED stock row is still refused deletion — the link is what makes the parent undeletable, so it must block both ways", async () => {
    const item = await make({ name: `${RUN}-blocked` });
    const eq = await makeEquipment(`${RUN}-blocked-eq`);
    await linkStockItemToEquipment(actor, item.id, eq.id);

    let caught: unknown;
    try {
      await deleteStockItem(actor, item.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).formErrors[0]).toContain("verknüpft");
    expect(await db.inventoryItem.findUnique({ where: { id: item.id } })).not.toBeNull();
    // …and the equipment side keeps the link it already had.
    expect(
      (await listEntityHistory(ENTITY_TYPE.equipment, eq.id, 20)).filter(
        (r) => r.action === HARMONY_ACTION.linked,
      ),
    ).toHaveLength(1);
  });
});

describe("the harmony module lives in the inventory domain folder", () => {
  it("(4) the harmony reader is `app/domains/inventory/inventory.*`, and no `app/domains/stock/` exists", () => {
    const here = fileURLToPath(new URL("../inventory.harmony.queries.server.ts", import.meta.url));
    expect(here.replace(/\\/g, "/")).toMatch(
      /\/app\/domains\/inventory\/inventory\.harmony\.queries\.server\.ts$/,
    );
    // The rejected alternative: a folder named after the thing it serves. It
    // would force the link to be maintained across a domain boundary, which is
    // what the domain-ownership rule bans — so its ABSENCE is the assertion.
    expect(
      existsSync(fileURLToPath(new URL("../../stock", import.meta.url))),
      "app/domains/stock/ must not exist",
    ).toBe(false);
  });
});

/** `undefined` on success, the error on refusal — so "did it raise?" is a value. */
async function tryDelete(equipmentId: string): Promise<unknown> {
  try {
    await db.equipment.delete({ where: { id: equipmentId } });
    return undefined;
  } catch (error) {
    return error;
  }
}
