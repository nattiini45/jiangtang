import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { createLocation } from "~/domains/locations/locations.mutations.server";
import { listLocationTree, type LocationTreeNode } from "~/domains/locations/locations.tree.server";
import type { LocationCreateInput } from "~/domains/locations/locations.schema";

/**
 * The location tree, one test per property:
 * every descendant, with depth and a stable order, from ONE recursive CTE — and
 * `kind` filtering the RESULT without truncating the TRAVERSAL.
 *
 * ```
 * ${RUN}-a-site          SITE      depth 0
 * └── ${RUN}-building    BUILDING  depth 1
 *     └── ${RUN}-room    ROOM      depth 2
 * └── ${RUN}-storage     STORAGE   depth 1
 *     └── ${RUN}-rack    RACK      depth 2
 * ${RUN}-b-site          SITE      depth 0
 * ```
 *
 * **The `kind` tests are the rot-check for this file.** The single most natural edit
 * to a recursive CTE is to push a filter into the recursive term, where it reads like
 * a `WHERE` and silently returns nothing instead of a node two levels down. The
 * assertions below name the case explicitly — a `ROOM` under a `BUILDING` comes back
 * at depth **2**, not depth 1 — so that edit turns this file red rather than quietly
 * turning the filter into a traversal cut.
 *
 * **The forest walk is not exact-counted.** The dev database carries the demo seed's
 * 8 locations, so `listLocationTree()` with no root returns those too. Every
 * forest assertion is therefore scoped to this run's own rows, by name prefix, and the
 * parentId-rooted walks — which this file owns end to end — are asserted exactly.
 */

const RUN = `tree_${Date.now().toString(36)}`;
const actor = { id: null, name: "Tree Tester", initials: "TT" };
const createdIds: string[] = [];

afterAll(async () => {
  for (const id of [...createdIds].reverse()) {
    await db.location.delete({ where: { id } }).catch(() => undefined);
  }
  await db.$disconnect();
});

async function make(name: string, kind: LocationCreateInput["kind"], parentId?: string) {
  const location = await createLocation(actor, { name: `${RUN}-${name}`, kind, parentId });
  createdIds.push(location.id);
  return location;
}

const names = (rows: LocationTreeNode[]) => rows.map((row) => row.name.replace(`${RUN}-`, ""));

/** Only this run's rows, in the order the query returned them. */
async function mine(
  options: Parameters<typeof listLocationTree>[0] = {},
): Promise<LocationTreeNode[]> {
  const rows = await listLocationTree(options);
  return rows.filter((row) => row.name.startsWith(`${RUN}-`));
}

let siteA: Awaited<ReturnType<typeof make>>;
let building: Awaited<ReturnType<typeof make>>;
let room: Awaited<ReturnType<typeof make>>;
let storage: Awaited<ReturnType<typeof make>>;
let rack: Awaited<ReturnType<typeof make>>;

beforeAll(async () => {
  // Built once, in parent-before-child order, so the afterAll unwind satisfies Restrict.
  siteA = await make("a-site", "SITE");
  building = await make("building", "BUILDING", siteA.id);
  room = await make("room", "ROOM", building.id);
  storage = await make("storage", "STORAGE", siteA.id);
  rack = await make("rack", "RACK", storage.id);
  // The second root exists to give the forest walk a sibling to sort against.
  await make("b-site", "SITE");
});

describe("listLocationTree — every descendant, depth and order", () => {
  it("(3) returns every descendant of a node, each with its depth in the tree", async () => {
    const rows = await listLocationTree({ parentId: siteA.id });

    expect(names(rows)).toEqual(["a-site", "building", "room", "storage", "rack"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1, 2]);
    expect(rows.map((row) => row.id)).toEqual([
      siteA.id,
      building.id,
      room.id,
      storage.id,
      rack.id,
    ]);
  });

  it("(3) orders depth-first, a parent immediately before its own children", async () => {
    // b-site sorts after the whole a-site subtree ("a" < "b"), and room sorts
    // immediately after its parent rather than being grouped by depth.
    expect(names(await mine())).toEqual([
      "a-site",
      "building",
      "room",
      "storage",
      "rack",
      "b-site",
    ]);
  });

  it("(3) the order is stable across calls", async () => {
    const first = await mine();
    const second = await mine();
    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id));
  });

  it("(3) walking the whole forest returns every root at depth 0", async () => {
    const rows = await mine();
    expect(names(rows).filter((name) => name.endsWith("site"))).toEqual(["a-site", "b-site"]);
    for (const row of rows.filter((row) => row.name.endsWith("site"))) expect(row.depth).toBe(0);
  });

  it("(3) a leaf returns only itself, at depth 0", async () => {
    const rows = await listLocationTree({ parentId: room.id });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(room.id);
    expect(rows[0].depth).toBe(0);
  });
});

describe("listLocationTree — kind filters the result, never the traversal", () => {
  it("(3) a ROOM under a BUILDING still comes back, at its real depth", async () => {
    const rows = await listLocationTree({ parentId: siteA.id, kind: "ROOM" });

    // Depth 2, not 1: the filter removed the BUILDING from the RESULT, not from the
    // walk. A filter pushed into the recursive term returns [] here instead.
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(room.id);
    expect(rows[0].depth).toBe(2);
  });

  it("(3) each kind returns exactly its own nodes, still through the others", async () => {
    const buildingRows = await listLocationTree({ parentId: siteA.id, kind: "BUILDING" });
    expect(buildingRows.map((row) => row.id)).toEqual([building.id]);
    expect(buildingRows[0].depth).toBe(1);

    const storageRows = await listLocationTree({ parentId: siteA.id, kind: "STORAGE" });
    expect(storageRows.map((row) => row.id)).toEqual([storage.id]);
    expect(storageRows[0].depth).toBe(1);

    // The RACK is only reachable by walking THROUGH the STORAGE, and it keeps its
    // own depth rather than being renumbered as if the STORAGE were the root.
    const rackRows = await listLocationTree({ parentId: siteA.id, kind: "RACK" });
    expect(rackRows.map((row) => row.id)).toEqual([rack.id]);
    expect(rackRows[0].depth).toBe(2);

    const siteRows = await listLocationTree({ parentId: siteA.id, kind: "SITE" });
    expect(siteRows.map((row) => row.id)).toEqual([siteA.id]);
  });

  it("(3) a kind nothing in the subtree has returns an empty list, not everything", async () => {
    const rows = await listLocationTree({ parentId: siteA.id, kind: "VEHICLE" });
    expect(rows).toEqual([]);
  });
});
