import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { db } from "~/lib/db.server";
import { cloneRoom } from "~/domains/rooms/rooms.mutations.server";
import type { RoomCloneInput } from "~/domains/rooms/rooms.schema";
import { ENTITY_TYPE, listEntityHistory } from "~/domains/tickets/tickets.history.server";

/**
 * The clone's `Equipment` write is owned by `inventory/`,
 * routed through its builder, and audited per row. One guard per acceptance
 * criterion:
 *
 *   (1) `rooms/` contains no `tx.equipment.` call and calls the owner's writer → tests 1–3
 *   (2) the writer routes the payload through `equipmentFields()`              → tests 4–5
 *   (3) the model id is CARRIED, and no `EquipmentModel` is created or
 *       resolved, so `catalog/`'s writer set is identical after a clone       → tests 6–8
 *   (4) one `EquipmentCreated` row per copied unit, in the clone's own
 *       transaction, AND the shipped equipment feed can read it               → tests 9–12
 *   (5) the copy is atomic — a failure mid-loop leaves nothing behind          → tests 13–14
 *   (6) behaviour unchanged: carried columns kept, FIXED only, the source
 *       `status` preserved, every unit-specific identifier cleared            → tests 15–16
 *
 * ⚠️ **The controls are the file, and each varies exactly one variable.**
 *
 *   - Tests 1–3 are one structural claim with three arms: `rooms/` must not write
 *     `Equipment`, must call the owner's writer, and the *detector* must fire on a
 *     string that does. A scan that cannot look returns the same answer as a scan
 *     that finds nothing, so the third arm is the only thing that gives the first
 *     two meaning.
 *   - Test 6 counts `EquipmentModel` rows across the WHOLE table, not the
 *     fixture's model, because a repair that resolved the model by name inside
 *     `inventory/` would FIND the fixture's model and create nothing — and would
 *     pass a check scoped to that model, which is the defect it exists to catch.
 *   - Tests 13–14 are the same operation on the same source room, differing only
 *     in the injected failure. Both arms must have written the first unit before
 *     the difference bites, or the probe says nothing about the loop: test 13
 *     asserts the control reached write #2, test 14 asserts the probe failed AT
 *     write #2 with one unit already written.
 *   - Test 16 is the negative arm of the clone's filter: if `RETIRED` and `POOLED`
 *     were no longer excluded, it is the arm that fails.
 *
 * ⚠️ **The fault injection sits at the writer seam, and it is the only way to
 * reach it.** Every column the clone copies is nullable and carries no
 * uniqueness, so no database constraint can fail mid-loop — a real `23505` or
 * `23503` is not producible from inside this copy. The injection makes the
 * *writer* throw on its Nth call, so the loop genuinely aborts mid-transaction
 * and what the assertions read afterwards is a real rollback, not a mocked one.
 * The recorded ids come from the wrapper, which is what makes "0 rows"
 * id-scoped rather than a global count against a shared dev database.
 *
 * ⚠️ **The source fixtures are minted BYPASSING the audited write path**
 * (`db.equipment.create`, not `createEquipment`). A fixture written through the
 * domain would contribute its own `EquipmentCreated` rows, and every audit
 * assertion here is scoped by id — the fixture must not be able to satisfy one.
 *
 * ActivityLog is append-only: nothing here deletes an audit row, and every
 * assertion is scoped to ids this file created.
 */

const RUN = `clone_${Date.now().toString(36)}`;
const actor = { id: null, name: "Clone Tester", initials: "CT" };

/** Fault injection, plus the ids the writer actually handed back. Hoisted for `vi.mock`. */
const injection = vi.hoisted(() => ({
  failOnCall: null as number | null,
  calls: 0,
  written: [] as string[],
}));

vi.mock("~/domains/inventory/inventory.mutations.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/domains/inventory/inventory.mutations.server")>();
  return {
    ...actual,
    createEquipmentInTx: async (...args: Parameters<typeof actual.createEquipmentInTx>) => {
      injection.calls += 1;
      if (injection.failOnCall !== null && injection.calls === injection.failOnCall) {
        throw new Error(`${RUN}: injected failure on write #${injection.calls}`);
      }
      const eq = await actual.createEquipmentInTx(...args);
      injection.written.push(eq.id);
      return eq;
    },
  };
});

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const roomsFile = read("../../rooms/rooms.mutations.server.ts");
const inventoryFile = read("../inventory.mutations.server.ts");

/** The body of one exported function, so "the clone path" is not "the whole file". */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} must still exist`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + signature.length);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

const cloneRoomBody = functionBody(roomsFile, "export async function cloneRoom");
const writerBody = functionBody(inventoryFile, "export async function createEquipmentInTx");

/** A `tx.<model>.<write>` call — the shape writer table is keyed on. */
const equipmentWrite = /\btx\.equipment\./;
/** Every model this body CREATES, in source order. "Which models does this folder write?" */
const createdModels = (body: string) =>
  [...body.matchAll(/\btx\.(\w+)\.create\(/g)].map((m) => m[1]);
/** A hand-written Equipment payload: the column list spelled out inline. */
const columnList =
  /\b(category|micKind|assetTag|serial|hostname|ipAddress|macAddress|dellServiceTag|dellExpressTag|frequencyMhz|band|channelLabel|lampType|lastLampChangeAt|color|attributes)\s*:/;
/**
 * The argument of a body's `tx.equipment.create( … )` call. Scoping matters: the
 * writer's AUDIT payload legitimately names `category`, and a column detector run
 * over the whole body would flag that and nothing else.
 */
const equipmentCreateArgs = (body: string) =>
  /tx\.equipment\.create\((\{[\s\S]*?\})\)/.exec(body)?.[1] ?? "";
/** The pre-B20 shape: the exact payload `rooms/` used to build inline. */
const PRE_B20_WRITER = [
  "export async function writeIt(tx, input) {",
  "  const eq = await tx.equipment.create({",
  "    data: {",
  "      roomId: room.id,",
  "      category: u.category,",
  "      assetTag: null,",
  "      serial: null,",
  "    },",
  "  });",
  "}",
].join("\n");

const ids = { campus: `${RUN}_campus`, model: `${RUN}_model` };
const sourceSlug = `${RUN}_source`;
/** Fixture unit names are unique, so a source can be matched to its copy by name. */
const names = {
  operational: `${RUN}-op`,
  faulty: `${RUN}-faulty`,
  retired: `${RUN}-retired`,
  pooled: `${RUN}-pooled`,
} as const;
type FixtureUnit = keyof typeof names;
const sourceIds: Record<FixtureUnit, string> = {
  operational: "",
  faulty: "",
  retired: "",
  pooled: "",
};
/** Copied verbatim. `roomId` is asserted separately — the copy belongs to the NEW room. */
const CARRIED = [
  "modelId",
  "category",
  "mobility",
  "status",
  "name",
  "micKind",
  "band",
  "lampType",
  "color",
] as const;
/** The unit-specific identifiers. The source has a value in each; every copy has none. */
const CLEARED = [
  "assetTag",
  "serial",
  "hostname",
  "ipAddress",
  "macAddress",
  "dellServiceTag",
  "dellExpressTag",
  "frequencyMhz",
  "channelLabel",
  "lastLampChangeAt",
  "attributes",
] as const;
/** Only these two source units may be copied. */
const COPIED: FixtureUnit[] = ["operational", "faulty"];

function cloneInput(name: string): RoomCloneInput {
  return {
    name,
    campusId: ids.campus,
    copyFeatures: false,
    copyCapabilities: false,
    copyTips: false,
    copyEquipment: true,
  };
}

/** One clone, one clean injection state. Every test that needs a clone calls this. */
async function makeClone(label: string, failOnCall: number | null = null) {
  injection.failOnCall = failOnCall;
  injection.calls = 0;
  injection.written.length = 0;
  const room = await cloneRoom(actor, sourceSlug, cloneInput(`${RUN} ${label}`));
  return { room, calls: injection.calls, written: [...injection.written] };
}

/** The two units a successful clone of the fixture room must have written. */
async function copiedUnits(roomId: string) {
  return db.equipment.findMany({ where: { roomId }, orderBy: { name: "asc" } });
}

async function dropClone(roomId: string) {
  await db.equipment.deleteMany({ where: { roomId } });
  await db.room.delete({ where: { id: roomId } });
}

beforeAll(async () => {
  await db.campus.create({ data: { id: ids.campus, name: ids.campus, slug: ids.campus } });
  await db.equipmentModel.create({
    data: { id: ids.model, name: ids.model, category: "PROJECTOR" },
  });
  const room = await db.room.create({
    data: { slug: sourceSlug, name: `${RUN} source`, campusId: ids.campus },
  });

  // Minted directly, NOT through createEquipment — see the header.
  const full = {
    roomId: room.id,
    modelId: ids.model,
    category: "PROJECTOR" as const,
    mobility: "FIXED" as const,
    status: "OPERATIONAL" as const,
    name: names.operational,
    micKind: "HANDHELD" as const,
    band: "G-Band",
    lampType: "U2",
    color: "weiss",
    assetTag: `${RUN}-asset`,
    serial: `${RUN}-serial`,
    hostname: `${RUN}-host`,
    ipAddress: "192.0.2.40",
    macAddress: "02:00:00:33:44:55",
    dellServiceTag: `${RUN}-dst`,
    dellExpressTag: `${RUN}-dexp`,
    frequencyMhz: "2400",
    channelLabel: "Funk 1",
    lastLampChangeAt: new Date("2026-01-15T10:00:00Z"),
    attributes: { origin: RUN },
  };
  sourceIds.operational = (await db.equipment.create({ data: full })).id;
  sourceIds.faulty = (
    await db.equipment.create({
      data: { ...full, name: names.faulty, status: "FAULTY", band: "S-Band" },
    })
  ).id;
  sourceIds.retired = (
    await db.equipment.create({ data: { ...full, name: names.retired, status: "RETIRED" } })
  ).id;
  sourceIds.pooled = (
    await db.equipment.create({
      data: { ...full, name: names.pooled, mobility: "POOLED", roomId: null },
    })
  ).id;
});

afterAll(async () => {
  // Equipment first (FK), then rooms, then the model, then the campus.
  await db.equipment.deleteMany({ where: { name: { startsWith: RUN } } });
  await db.room.deleteMany({
    where: { OR: [{ slug: sourceSlug }, { name: { startsWith: RUN } }] },
  });
  await db.equipmentModel.deleteMany({ where: { id: ids.model } });
  await db.campus.deleteMany({ where: { id: ids.campus } });
  await db.$disconnect();
});

describe("the Equipment write is owned by inventory/", () => {
  it("(1) rooms/ contains no tx.equipment. call", () => {
    // The whole folder, not just cloneRoom: the rule is about the folder.
    expect(roomsFile).not.toMatch(equipmentWrite);
  });

  it("(1) the clone path calls the owner's writer, and creates exactly one model — the one rooms/ owns", () => {
    expect(cloneRoomBody).toContain("createEquipmentInTx(tx, audit");
    // The clone still creates the Room inline; that is `rooms/`' own model and is
    // allowed. What it must not do is build an Equipment payload of its own.
    expect(createdModels(cloneRoomBody)).toEqual(["room"]);
  });

  it("(1) CONTROL — the detectors fire on the pre-B20 shape and stay quiet on the sanctioned call", () => {
    // A scan that cannot look reports the same thing as a clean scan, so these
    // positive arms are what give tests 1 and 2 their meaning.
    expect(PRE_B20_WRITER).toMatch(equipmentWrite);
    expect(createdModels(PRE_B20_WRITER)).toEqual(["equipment"]);
    expect(PRE_B20_WRITER).toMatch(columnList);
    // The sanctioned call must trip none of them, or the guards are unfalsifiable.
    const sanctioned =
      "        await createEquipmentInTx(tx, audit, {\n          roomId: room.id,\n        });";
    expect(sanctioned).not.toMatch(equipmentWrite);
    expect(sanctioned).not.toMatch(columnList);
  });
});

describe("the payload goes through equipmentFields()", () => {
  it("(2) the writer builds its payload with the shared builder and opens no transaction of its own", () => {
    expect(writerBody).toContain("equipmentFields(input)");
    // The create's data IS the builder's return value, not a second literal.
    expect(writerBody).toMatch(
      /tx\.equipment\.create\(\{\s*data:\s*equipmentFields\(input\)\s*,?\s*\}\)/,
    );
    // No hand-maintained column list inside the create: not one Equipment column is
    // spelled out there, which is the whole point — a caller can no longer drift
    // from the builder. Scoped to the create's own argument, because the audit
    // payload below it does name `category`, and that is not a column list.
    expect(equipmentCreateArgs(writerBody)).not.toMatch(columnList);
    // It JOINS the caller's transaction — that is what makes criterion (5) possible.
    expect(writerBody).not.toContain("$transaction");
    expect(writerBody).not.toContain("txWithAudit");
  });

  it("(2) CONTROL — the builder is called exactly once, and the column detector is not blind", () => {
    // Proves test 4 passes for the right reason rather than because a containment
    // check that can never fire would pass anyway.
    expect(writerBody.match(/equipmentFields\(/g)).toHaveLength(1);
    // The column detector fires on the pre-B20 create's argument, and would have
    // fired on this writer's had the payload been inlined.
    expect(equipmentCreateArgs(PRE_B20_WRITER)).toMatch(columnList);
    expect(equipmentCreateArgs(PRE_B20_WRITER)).not.toMatch(/equipmentFields\(/);
  });
});

describe("the model id is carried, and no model is created or resolved", () => {
  it("(3) every copied unit carries its source unit's model id", async () => {
    const { room } = await makeClone("model-carry");
    const copies = await copiedUnits(room.id);
    expect(copies.map((c) => c.name).sort()).toEqual([names.faulty, names.operational].sort());
    for (const copy of copies) {
      const unit: FixtureUnit = copy.name === names.faulty ? "faulty" : "operational";
      const source = await db.equipment.findUniqueOrThrow({ where: { id: sourceIds[unit] } });
      expect(copy.modelId, `${copy.name} must carry its source's model id`).toBe(source.modelId);
      expect(copy.modelId).toBe(ids.model);
    }
    await dropClone(room.id);
  });

  it("(3) a clone creates NO EquipmentModel — counted over the WHOLE table, not the fixture's model", async () => {
    // A repair that resolved the model by name inside `inventory/` would FIND the
    // fixture's model and create nothing, so a count scoped to that model would
    // pass the very defect this guard forbids. The table-wide count catches both
    // directions: a create, and a resolve-and-miss.
    const before = await db.equipmentModel.count();
    const { room } = await makeClone("model-probe");
    const after = await db.equipmentModel.count();
    expect(after, "a clone must not create an EquipmentModel").toBe(before);
    // …and the copies still carry a RESOLVED id, so the count above is not zero
    // because the model reference was dropped along with the resolution.
    const copies = await copiedUnits(room.id);
    expect(copies).toHaveLength(2);
    expect(copies.every((c) => c.modelId === ids.model)).toBe(true);
    await dropClone(room.id);
  });

  it("(3) CONTROL — the clone path mentions no model table, and the scan can see one", () => {
    expect(cloneRoomBody).not.toMatch(/\bequipmentModel\b/);
    const elsewhere =
      "          const model = await tx.equipmentModel.create({ data: { name: row.modelText } });";
    expect(elsewhere).toMatch(/\bequipmentModel\b/);
  });
});

describe("one audit row per copied unit, readable by the shipped feed", () => {
  it("(4) each copied unit carries its own EquipmentCreated row", async () => {
    const { room, written } = await makeClone("audit-per-row");
    const copies = await copiedUnits(room.id);
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      const rows = await db.activityLog.findMany({
        where: { entityType: "equipment", entityId: copy.id },
      });
      expect(rows, `${copy.name} must carry its own create row`).toHaveLength(1);
      expect(rows[0].action).toBe("EquipmentCreated");
      expect(rows[0].actorSnapshot).toMatchObject({ initials: "CT" });
    }
    // The exact created-id list: what the writer handed back IS what landed.
    expect([...written].sort()).toEqual(copies.map((c) => c.id).sort());
    await dropClone(room.id);
  });

  it("(4) the exact audit-action list across the copied units", async () => {
    const { room } = await makeClone("audit-actions");
    const copies = await copiedUnits(room.id);
    const rows = await db.activityLog.findMany({
      where: { entityType: "equipment", entityId: { in: copies.map((c) => c.id) } },
      orderBy: { occurredAt: "asc" },
    });
    // One action, one row per unit — a summary row would show up here as a second
    // action, and a missing per-row row as a shorter list.
    expect(rows.map((r) => r.action)).toEqual(["EquipmentCreated", "EquipmentCreated"]);
    expect(rows.map((r) => r.entityId).sort()).toEqual(copies.map((c) => c.id).sort());
    await dropClone(room.id);
  });

  it("(4) the SHIPPED equipment page's reader returns the row — this is why the per-row shape exists", async () => {
    const { room } = await makeClone("audit-feed");
    const copy = (await copiedUnits(room.id))[0];
    // Exactly the call `app/routes/_desktop.inventory.$id/route.tsx:58` makes.
    const feed = await listEntityHistory(ENTITY_TYPE.equipment, copy.id, 20);
    expect(feed.map((r) => r.action)).toContain("EquipmentCreated");
    await dropClone(room.id);
  });

  it("(4) RoomCloned KEPT its aggregate — the per-row rows are added, not substituted", async () => {
    const { room } = await makeClone("audit-room-aggregate");
    const rows = await db.activityLog.findMany({
      where: { entityType: "room", entityId: room.id, action: "RoomCloned" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].data).toMatchObject({ copiedEquipment: 2 });
    await dropClone(room.id);
  });
});

describe("the copy is atomic", () => {
  it("(5) CONTROL — the same clone with no injected failure writes both units", async () => {
    const { room, calls, written } = await makeClone("atomic-control", null);
    // The control must have reached the SECOND write, or the probe below is not
    // testing the loop: a failure on write #1 would prove nothing about a mid-loop abort.
    expect(calls, "the control must reach the second write").toBe(2);
    expect(written).toHaveLength(2);
    expect(await db.equipment.count({ where: { roomId: room.id } })).toBe(2);
    await dropClone(room.id);
  });

  it("(5) a failure on the SECOND write leaves 0 units, 0 audit rows and no cloned room", async () => {
    const name = `${RUN} atomic-probe`;
    injection.failOnCall = 2;
    injection.calls = 0;
    injection.written.length = 0;

    let caught: unknown;
    try {
      await cloneRoom(actor, sourceSlug, cloneInput(name));
    } catch (error) {
      caught = error;
    }
    expect(caught, "the injected failure must reach the caller").toBeInstanceOf(Error);
    // The failure really happened MID-loop: one unit had already been written.
    expect(
      injection.written,
      "the first unit must have been written before the abort",
    ).toHaveLength(1);

    // The id the loop HAD written is gone — id-scoped, not a global count.
    const leaked = await db.equipment.findUnique({ where: { id: injection.written[0] } });
    expect(leaked, "the already-written unit must be rolled back").toBeNull();
    const ghostAudit = await db.activityLog.count({
      where: { entityType: "equipment", entityId: injection.written[0] },
    });
    expect(ghostAudit, "a rolled-back unit must leave no audit row").toBe(0);
    // And no room: the clone's own row rolled back with it.
    expect(await db.room.count({ where: { name } })).toBe(0);

    injection.failOnCall = null;
  });
});

describe("behaviour unchanged", () => {
  it("(6) the operational source unit is reproduced column for column, identifiers cleared", async () => {
    const { room } = await makeClone("shape");
    const source = await db.equipment.findUniqueOrThrow({ where: { id: sourceIds.operational } });
    const copy = await db.equipment.findFirstOrThrow({
      where: { roomId: room.id, name: names.operational },
    });

    expect(copy.id, "a clone is a NEW unit, not a move").not.toBe(source.id);
    expect(copy.roomId, "the copy belongs to the NEW room").toBe(room.id);
    // Carried: identical, including every column the old inline payload wrote.
    for (const column of CARRIED) {
      expect(copy[column], `${column} must be carried across`).toEqual(source[column]);
    }
    // Cleared: the source has a value in each of these, the copy has none. The
    // `not.toBeNull()` half is what stops this loop from being vacuous.
    for (const column of CLEARED) {
      expect(source[column], `the source must actually carry ${column}`).not.toBeNull();
      expect(copy[column], `${column} must NOT be copied`).toBeNull();
    }
    // The load-bearing comment at the clone site: a broken unit stays broken.
    expect(copy.mobility).toBe("FIXED");
    await dropClone(room.id);
  });

  it("(6) a FAULTY unit is cloned as FAULTY, and the second unit's own values came across", async () => {
    const { room } = await makeClone("status");
    const faulty = await db.equipment.findFirstOrThrow({
      where: { roomId: room.id, name: names.faulty },
    });
    expect(faulty.status, "a FAULTY unit must not be cloned into an OPERATIONAL one").toBe(
      "FAULTY",
    );
    expect(faulty.band, "the second unit's carried columns came across too").toBe("S-Band");
    await dropClone(room.id);
  });

  it("(6) CONTROL — a RETIRED and a POOLED source unit are NOT copied, and the source room still has all four", async () => {
    const { room } = await makeClone("filter");
    const copied = await copiedUnits(room.id);
    // The negative arm: drop the filter and these two appear.
    expect(copied.map((c) => c.name).sort()).toEqual([...COPIED].map((u) => names[u]).sort());
    // …and all four source units are still there, unmoved: three keep the source
    // room, the POOLED one keeps none. A clone that MOVED gear would fail this.
    const still = await db.equipment.findMany({ where: { id: { in: Object.values(sourceIds) } } });
    expect(still).toHaveLength(4);
    const source = await db.room.findUniqueOrThrow({
      where: { slug: sourceSlug },
      select: { id: true },
    });
    const inRoom = still
      .filter((e) => e.roomId === source.id)
      .map((e) => e.id)
      .sort();
    expect(inRoom).toEqual([sourceIds.operational, sourceIds.faulty, sourceIds.retired].sort());
    expect(
      still.find((e) => e.id === sourceIds.pooled)?.roomId,
      "the POOLED unit belongs to no room",
    ).toBeNull();
    await dropClone(room.id);
  });
});
