import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { ValidationError, hasSqlState } from "~/lib/errors.server";
import {
  createLocation,
  deleteLocation,
  moveLocation,
  updateLocation,
} from "~/domains/locations/locations.mutations.server";
import type { LocationCreateInput, LocationEditInput } from "~/domains/locations/locations.schema";

/**
 * Location mutation guards, by property:
 *
 *   (1) every mutation is `txWithAudit` and writes its ActivityLog row in the same
 *       transaction  → the "exactly one row" assertions below
 *   (2) a REFUSED mutation (cycle, delete-with-children) writes no ActivityLog row
 *       and no state change                                    → tests 4, 6, 7
 *   (4) `deleteLocation` on a node with children throws `ValidationError` naming the
 *       child count, and no raw `P2003` reaches the caller     → tests 3, 4
 *   (5) `moveLocation` under one's own descendant throws and writes nothing; under
 *       an unrelated node it succeeds and the subtree follows  → tests 6, 7, 8
 *
 * **Test 5 is the non-vacuity control for the whole file**: it deletes a parent with
 * `db.location.delete` and asserts Postgres itself refuses (SQLSTATE `23001` — see
 * the note in the test about why that is *not* `P2003` on this stack). Without it, the
 * refusals in tests 3/6 could be passing because the domain is careful, or because
 * the constraint is doing the work and the handler is decorative — the test cannot
 * tell, and neither can a reader.
 *
 * ActivityLog is append-only, so nothing here deletes audit rows; every assertion
 * is scoped to the ids this file created.
 */

const RUN = `loc_${Date.now().toString(36)}`;
const actor = { id: null, name: "Location Tester", initials: "LT" };

/** Created children-before-parents, so the afterAll can unwind in reverse and satisfy Restrict. */
const createdIds: string[] = [];
const vendorIds: string[] = [];
const taskIds: string[] = [];

afterAll(async () => {
  await db.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  for (const id of [...createdIds].reverse()) {
    await db.location.delete({ where: { id } }).catch(() => undefined);
  }
  await db.$disconnect();
});

function input(
  over: Partial<LocationCreateInput> & { name: string; kind: LocationCreateInput["kind"] },
): LocationCreateInput {
  return {
    code: undefined,
    address: undefined,
    description: undefined,
    parentId: undefined,
    ...over,
  };
}

async function make(
  over: Partial<LocationCreateInput> & { name: string; kind: LocationCreateInput["kind"] },
) {
  const location = await createLocation(actor, input(over));
  createdIds.push(location.id);
  return location;
}

/** Every audit row this file's entity produced, in order. */
function auditFor(id: string) {
  return db.activityLog.findMany({
    where: { entityType: "location", entityId: id },
    orderBy: { occurredAt: "asc" },
  });
}

/** A three-level chain: site → building → room, plus a sibling subtree. */
async function makeTree() {
  const site = await make({ name: `${RUN}-site`, kind: "SITE" });
  const building = await make({ name: `${RUN}-building`, kind: "BUILDING", parentId: site.id });
  const room = await make({ name: `${RUN}-room`, kind: "ROOM", parentId: building.id });
  return { site, building, room };
}

describe("location mutations — audit in the same transaction", () => {
  it("(1) create writes exactly one LocationCreated row carrying the actor snapshot", async () => {
    const site = await make({ name: `${RUN}-audit-site`, kind: "SITE", code: "A-1" });

    const logs = await auditFor(site.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("LocationCreated");
    expect(logs[0].actorSnapshot).toMatchObject({ initials: "LT" });
    expect(logs[0].data).toMatchObject({ kind: "SITE", parentId: null });
  });

  it("(1) update writes exactly one LocationUpdated row and no second create row", async () => {
    const site = await make({ name: `${RUN}-update-site`, kind: "SITE" });
    const before = (await auditFor(site.id)).length;

    const edit: LocationEditInput = {
      id: site.id,
      name: `${RUN}-update-site-renamed`,
      kind: "BUILDING",
    };
    const updated = await updateLocation(actor, site.id, edit);
    expect(updated.name).toBe(`${RUN}-update-site-renamed`);
    expect(updated.kind).toBe("BUILDING");
    expect(updated.parentId).toBeNull(); // updateLocation must not touch the edge

    const logs = await auditFor(site.id);
    expect(logs).toHaveLength(before + 1);
    expect(logs.at(-1)?.action).toBe("LocationUpdated");
    expect(logs.at(-1)?.data).toMatchObject({ from: { name: `${RUN}-update-site`, kind: "SITE" } });
  });

  it("(4) delete of a leaf removes the row and writes exactly one LocationDeleted row", async () => {
    const site = await make({ name: `${RUN}-leaf`, kind: "STORAGE" });
    const before = (await auditFor(site.id)).length;

    await deleteLocation(actor, site.id);

    expect(await db.location.findUnique({ where: { id: site.id } })).toBeNull();
    const logs = await auditFor(site.id);
    expect(logs).toHaveLength(before + 1);
    expect(logs.at(-1)?.action).toBe("LocationDeleted");
  });
});

describe("location mutations — refusals write nothing", () => {
  it("(4) delete with children throws ValidationError naming the DIRECT child count, and changes nothing", async () => {
    const { site, building, room } = await makeTree();
    // A second direct child, so the count in the message is 2 while the subtree
    // under `site` holds 3 descendants. A count that leaked the whole subtree would
    // say 3 here; a count that was hard-coded would say anything at all.
    const second = await make({ name: `${RUN}-shed`, kind: "STORAGE", parentId: site.id });
    const auditBefore = (await auditFor(site.id)).length;

    let thrown: unknown;
    try {
      await deleteLocation(actor, site.id);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const message = (thrown as ValidationError).formErrors.join(" ");
    expect(message).toMatch(/noch 2 untergeordnete Standorte/);
    expect(message).not.toMatch(/noch 3/);
    expect(message).toContain(site.name);

    // Nothing was written: the node and its whole subtree are still there …
    expect(await db.location.findUnique({ where: { id: site.id } })).not.toBeNull();
    expect(await db.location.findUnique({ where: { id: building.id } })).not.toBeNull();
    expect(await db.location.findUnique({ where: { id: room.id } })).not.toBeNull();
    expect(await db.location.findUnique({ where: { id: second.id } })).not.toBeNull();
    // … and no ActivityLog row was added: the audit records
    // what happened, and "nothing happened" is not an event.
    expect(await auditFor(site.id)).toHaveLength(auditBefore);
    expect((await auditFor(site.id)).some((row) => row.action === "LocationDeleted")).toBe(false);
  });

  it("(4) CONTROL — the database really does refuse it, so the handler is the gate and Restrict the backstop", async () => {
    const { site } = await makeTree();

    // Bypass the domain entirely. If the FK were not `Restrict`, this would succeed
    // and the assertion above would be testing nothing but the domain's caution.
    let thrown: unknown;
    try {
      await db.location.delete({ where: { id: site.id } });
    } catch (error) {
      thrown = error;
    }

    // ⚠️ On this stack a Restrict violation is NOT Prisma's
    // `P2003`. `@prisma/adapter-pg` raises a `DriverAdapterError` with SQLSTATE
    // `23001` in `.cause.code`, so the P2003 error cannot occur here at all, and a handler
    // that matched on "P2003" would let the raw driver error through. The guard still holds,
    // and more strongly: the caller sees a ValidationError, never a driver error.
    expect(thrown).toBeDefined();
    expect(hasSqlState(thrown, "23001")).toBe(true);
    expect((thrown as { message?: string }).message).toContain("Location_parentId_fkey");

    // The backstop is live too: the same violation through the domain surfaces as a
    // ValidationError, not as a driver error.
    const domained = await deleteLocation(actor, site.id).catch((error: unknown) => error);
    expect(domained).toBeInstanceOf(ValidationError);

    // And the row is still there — both refusals left the subtree alone.
    expect(await db.location.findUnique({ where: { id: site.id } })).not.toBeNull();
  });

  it("(5) move under one's own descendant throws, changes no edge, and writes no row", async () => {
    const { site, building, room } = await makeTree();
    const auditBefore = (await auditFor(building.id)).length;

    await expect(moveLocation(actor, building.id, room.id)).rejects.toBeInstanceOf(ValidationError);

    const unchanged = await db.location.findUnique({ where: { id: building.id } });
    expect(unchanged?.parentId).toBe(site.id);
    expect(await auditFor(building.id)).toHaveLength(auditBefore);
    expect((await auditFor(building.id)).some((row) => row.action === "LocationMoved")).toBe(false);
  });

  it("(5) move under itself throws", async () => {
    const { building } = await makeTree();
    await expect(moveLocation(actor, building.id, building.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await db.location.findUnique({ where: { id: building.id } }))?.parentId).not.toBe(
      building.id,
    );
  });

  it("(5) move under an unknown parent throws and writes nothing", async () => {
    const { building } = await makeTree();
    const auditBefore = (await auditFor(building.id)).length;

    await expect(moveLocation(actor, building.id, `${RUN}-does-not-exist`)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect((await db.location.findUnique({ where: { id: building.id } }))?.parentId).not.toBe(
      `${RUN}-does-not-exist`,
    );
    expect(await auditFor(building.id)).toHaveLength(auditBefore);
  });
});

describe("location mutations — a legal move takes the subtree with it", () => {
  it("(5) moving under an unrelated node succeeds, audits once, and the subtree follows", async () => {
    const { site, building, room } = await makeTree();
    const elsewhere = await make({ name: `${RUN}-elsewhere`, kind: "SITE" });
    const auditBefore = (await auditFor(building.id)).length;

    const moved = await moveLocation(actor, building.id, elsewhere.id);
    expect(moved.parentId).toBe(elsewhere.id);

    const logs = await auditFor(building.id);
    expect(logs).toHaveLength(auditBefore + 1);
    expect(logs.at(-1)?.action).toBe("LocationMoved");
    expect(logs.at(-1)?.data).toMatchObject({ fromParentId: site.id, toParentId: elsewhere.id });

    // The subtree followed: the room is still the building's child, and the
    // building is no longer under the old site.
    expect((await db.location.findUnique({ where: { id: room.id } }))?.parentId).toBe(building.id);
    expect((await db.location.findUnique({ where: { id: building.id } }))?.parentId).toBe(
      elsewhere.id,
    );
  });

  it("(5) moving a node to the root (parentId: null) succeeds and is audited", async () => {
    const { site, building } = await makeTree();

    const promoted = await moveLocation(actor, building.id, null);
    expect(promoted.parentId).toBeNull();
    expect(await db.location.findUnique({ where: { id: site.id } })).not.toBeNull();
    expect((await auditFor(building.id)).at(-1)?.action).toBe("LocationMoved");
  });

  it("(5) a move that would not change the edge is refused rather than audited", async () => {
    const { site, building } = await makeTree();
    await expect(moveLocation(actor, building.id, site.id)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("location mutations — SetNull references are detached, and the audit says so", () => {
  it("deleting a referenced leaf keeps the referencing rows and records the detached counts", async () => {
    const store = await make({ name: `${RUN}-store`, kind: "STORAGE" });
    const vendor = await db.vendor.create({
      data: { name: `${RUN}-vendor`, locationId: store.id },
    });
    vendorIds.push(vendor.id);
    const task = await db.task.create({
      data: { title: `${RUN}-task`, status: "TODO", priority: "MEDIUM", locationId: store.id },
    });
    taskIds.push(task.id);

    await deleteLocation(actor, store.id);

    // SetNull, per — the rows survive, they lose their place.
    expect((await db.vendor.findUnique({ where: { id: vendor.id } }))?.locationId).toBeNull();
    expect((await db.task.findUnique({ where: { id: task.id } }))?.locationId).toBeNull();

    // …and the consequence is on the record rather than silent.
    const log = (await auditFor(store.id)).at(-1);
    expect(log?.action).toBe("LocationDeleted");
    expect(log?.data).toMatchObject({
      detached: { vendors: 1, tasks: 1, inventoryItems: 0, notes: 0 },
    });
  });
});
