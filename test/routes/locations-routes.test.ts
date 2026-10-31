import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";

/**
 * Loader/action tests for the `/locations*` + `/m/locations` routes.
 *
 * ⚠️ **This is not a render test.** Vitest runs in `node` with no DOM, so these
 * call the exported `loader`/`action` directly against the real dev database.
 * Whether the tree *draws* correctly is an end-to-end concern (Playwright). What is
 * provable here — and what this file is for — is that the routes compute the
 * right answer, refuse the right things, and write nothing when they refuse.
 *
 * `requireUser` is mocked to a fixed actor (the `m-tickets-routes.test.ts`
 * precedent); every other export of `~/lib/auth.server` is preserved.
 *
 * Two criteria are deliberately *structural* rather than behavioural, because
 * their failure mode is invisible to a green suite: criterion (2)'s "no new
 * public surface" and "the loader must not reach for the client". Both
 * assert on source text, so a later slice that quietly widens a file is caught
 * by a test that names the reason.
 */
const RUN = `b7_loc_${Date.now()}`;

const TEST_USER: AuthUser = {
  id: null as unknown as string,
  name: "Locations Tester",
  email: `${RUN}@test.local`,
  initials: "LT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => TEST_USER) };
});

// Imported AFTER the mock so the route modules see the mocked requireUser.
const indexRoute = await import("~/routes/_desktop.locations._index/route");
const newRoute = await import("~/routes/_desktop.locations.new/route");
const detailRoute = await import("~/routes/_desktop.locations.$id/route");
const editRoute = await import("~/routes/_desktop.locations.$id_.edit/route");
const mobileRoute = await import("~/routes/m.locations._index/route");

/** ── Fixtures ─────────────────────────────────────────────────────────────── */

/**
 * A tree with the shape the `kind` filter's whole reason for existing needs:
 *   ${RUN}_site            SITE
 *     ${RUN}_bld           BUILDING
 *       ${RUN}_room        ROOM      ← a ROOM two levels down, under a BUILDING
 *     ${RUN}_external      EXTERNAL
 *   ${RUN}_room_root       ROOM      ← a root ROOM, so ROOM ≠ SITE is provable
 */
const ids = {
  site: `${RUN}_site`,
  building: `${RUN}_bld`,
  room: `${RUN}_room`,
  external: `${RUN}_external`,
  roomRoot: `${RUN}_room_root`,
};

const created: string[] = [];

/**
 * Fixtures are written with the client directly, NOT through `createLocation`.
 *
 * Two reasons, both about the assertions below rather than about tidiness:
 * the tests need **known ids** to name rows (a cuid would force every assertion
 * to rediscover it), and the audit-count checks measure rows *written by the
 * routes*, so fixture noise on the same entity ids would make them lie. The
 * precedent is `list-filter-parsing.test.ts`, which seeds `db.ticket.createMany`
 * for the same reason.
 */
async function seed(
  id: string,
  kind: "SITE" | "BUILDING" | "ROOM" | "EXTERNAL",
  name: string,
  parentId: string | null,
) {
  await db.location.create({ data: { id, name, kind, parentId } });
  created.push(id);
  return id;
}

beforeAll(async () => {
  await seed(ids.site, "SITE", `${RUN} Campus`, null);
  await seed(ids.building, "BUILDING", `${RUN} Gebäude`, ids.site);
  await seed(ids.room, "ROOM", `${RUN} Hörsaal`, ids.building);
  await seed(ids.external, "EXTERNAL", `${RUN} extern`, ids.site);
  await seed(ids.roomRoot, "ROOM", `${RUN} mobiler Raum`, null);
});

afterAll(async () => {
  // Detach first: `Location.parentId` is `Restrict`, so deleting a parent with
  // children is refused by the database — the same refusal the page renders inline.
  // Detaching makes cleanup order-independent, which matters because the move
  // test below rearranges the edges.
  await db.location.updateMany({ where: { id: { in: created } }, data: { parentId: null } });
  await db.location.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

/** ── Helpers ──────────────────────────────────────────────────────────────── */

const req = (url: string, body?: Record<string, string>): Request => {
  if (!body) return new Request(url);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
};

const loadIndex = (query = "") =>
  indexRoute.loader({
    request: new Request(`http://localhost/locations${query}`),
  } as never) as Promise<{
    nodes: Array<{ id: string; kind: string; depth: number }>;
    kind: string;
  }>;

const idSet = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));

/** ActivityLog rows for OUR entities only — the table is append-only and global. */
const auditCount = () => db.activityLog.count({ where: { entityId: { in: created } } });

// ── Criterion (1): the tree, and the `kind` filter round-tripping through the URL.

describe("locations index loader — the kind filter is the URL and nothing else", () => {
  it("returns the whole forest unfiltered, with each node at its REAL depth", async () => {
    const { nodes, kind } = await loadIndex();
    expect(kind).toBe("");
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get(ids.site)?.depth).toBe(0);
    expect(byId.get(ids.building)?.depth).toBe(1);
    // The depth assertion is the one that matters: it is the number the tree
    // component indents by, and a walk that returned depth-in-filtered-result
    // would flatten a filtered view into a flat list.
    expect(byId.get(ids.room)?.depth).toBe(2);
  });

  it("?kind=ROOM returns ONLY rooms — and still finds the one under a BUILDING", async () => {
    const { nodes, kind } = await loadIndex("?kind=ROOM");
    expect(kind).toBe("ROOM");
    expect(nodes.every((n) => n.kind === "ROOM")).toBe(true);
    // The traversal is not truncated by the filter: this room sits two levels
    // down, and it still comes back. Asserted by id, not by count.
    expect(idSet(nodes).has(ids.room)).toBe(true);
    expect(idSet(nodes).has(ids.site)).toBe(false);
    expect(idSet(nodes).has(ids.building)).toBe(false);
  });

  it("the filtered set genuinely DIFFERS from the unfiltered one (a filter that is ignored cannot pass)", async () => {
    const all = idSet((await loadIndex()).nodes);
    const rooms = idSet((await loadIndex("?kind=ROOM")).nodes);
    expect(rooms.size).toBeLessThan(all.size);
    for (const id of rooms) expect(all.has(id)).toBe(true);
  });

  it("the same URL reproduces the same view — a copied link is the whole state", async () => {
    const first = await loadIndex("?kind=ROOM");
    const second = await loadIndex("?kind=ROOM");
    expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
    expect(second.kind).toBe(first.kind);
  });

  it("ignores a garbage ?kind instead of throwing or 500", async () => {
    const { kind, nodes } = await loadIndex("?kind=NONSENSE");
    expect(kind).toBe("");
    expect(nodes.length).toBeGreaterThan(0);
  });

  it("ignores a prototype key (?kind=toString) — the guard is an own-VALUES check", async () => {
    // `raw in EnumObj` would let this through into a Prisma enum filter.
    const { kind } = await loadIndex("?kind=toString");
    expect(kind).toBe("");
  });
});

// ── Criterion (2): the node's descendants, behind the auth-guarded layout.

describe("locations detail loader", () => {
  it("returns the node's descendants, and NOT the node itself", async () => {
    const data = (await detailRoute.loader({ params: { id: ids.site } } as never)) as {
      location: { id: string };
      descendants: Array<{ id: string }>;
    };
    expect(data.location.id).toBe(ids.site);
    const descendants = idSet(data.descendants);
    expect(descendants.has(ids.site)).toBe(false);
    expect(descendants.has(ids.building)).toBe(true);
    expect(descendants.has(ids.external)).toBe(true);
    // Depth 2 — the whole subtree, not just the direct children.
    expect(descendants.has(ids.room)).toBe(true);
    // An unrelated root is not a descendant of this node.
    expect(descendants.has(ids.roomRoot)).toBe(false);
  });

  it("is scoped to the node: a child sees its own children, not its siblings or its parent", async () => {
    const data = (await detailRoute.loader({ params: { id: ids.building } } as never)) as {
      descendants: Array<{ id: string }>;
    };
    const descendants = idSet(data.descendants);
    expect([...descendants]).toEqual([ids.room]);
  });

  it("a leaf node has an empty descendant list, not an error", async () => {
    const data = (await detailRoute.loader({ params: { id: ids.roomRoot } } as never)) as {
      descendants: Array<{ id: string }>;
    };
    expect(data.descendants).toEqual([]);
  });

  it("an unknown id is a 404 response, not a crash", async () => {
    const thrown = await (
      detailRoute.loader({ params: { id: `${RUN}_missing` } } as never) as Promise<unknown>
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  // ── Structural: the two things a green suite cannot see on its own. ────────

  it("no locations route reaches for the Prisma client or db.server itself", () => {
    const sources = [
      "../../app/routes/_desktop.locations._index/route.tsx",
      "../../app/routes/_desktop.locations.new/route.tsx",
      "../../app/routes/_desktop.locations.$id/route.tsx",
      "../../app/routes/_desktop.locations.$id_.edit/route.tsx",
      "../../app/routes/m.locations._index/route.tsx",
    ].map((rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));

    for (const src of sources) {
      // ⚠️ Asserted over the IMPORT SPECIFIERS, not over the file text. Two
      // reasons, both measured on this slice's own files rather than assumed:
      //
      //  - a raw `/\bdb\.\w/` scan cannot tell code from prose, and the detail
      //    route *names* `~/lib/db.server` in the comment that explains this
      //    rule — so the check flagged its own explanation. `guards.sh` #4 hit
      //    the identical trap and solved it with a comment stripper; here the
      //    precise statement is one level simpler. `db` cannot reach a module
      //    without being imported, so the import IS the boundary.
      //  - the ban is `/client`, not all of `~/generated/prisma`: the enums
      //    module is a frozen const map with no database handle, and the index
      //    loader legitimately needs `LocationKind` to validate `?kind=`.
      const specifiers = [...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);

      expect(specifiers).not.toContain("~/lib/db.server");
      expect(specifiers).not.toContain("~/generated/prisma/client");
      expect(specifiers.some((s) => s.startsWith("@prisma/client"))).toBe(false);
      // Every domain read goes through a module, never through the client.
      expect(specifiers.filter((s) => s.startsWith("~/domains/"))).not.toHaveLength(0);
    }
  });

  it("every locations route sits under an auth-guarded layout, and both layouts guard", () => {
    const layout = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    // The guard the criterion depends on, asserted where it lives: a new public
    // surface would have to be opted out explicitly, and no opt-out is added.
    expect(layout("../../app/routes/_desktop/route.tsx")).toMatch(/requireUser\(request\)/);
    expect(layout("../../app/routes/m/route.tsx")).toMatch(/requireUser\(request\)/);

    // …and nothing in this slice sits outside those two subtrees.
    const routeFiles = [
      "../../app/routes/_desktop.locations._index/route.tsx",
      "../../app/routes/_desktop.locations.new/route.tsx",
      "../../app/routes/_desktop.locations.$id/route.tsx",
      "../../app/routes/_desktop.locations.$id_.edit/route.tsx",
      "../../app/routes/m.locations._index/route.tsx",
    ];
    for (const rel of routeFiles) {
      expect(rel).toMatch(/^\.\.\/\.\.\/app\/routes\/(_desktop|m)\./);
    }
  });
});

// ── Criterion (3): new/edit post to the location mutations; a refusal is inline, not a 500.

describe("locations new action", () => {
  it("creates through the domain and redirects to the new node", async () => {
    const res = await newRoute.action({
      request: req("http://localhost/locations/new", {
        name: `${RUN} neu`,
        kind: "STORAGE",
        code: `${RUN}-C1`,
        address: "",
        description: "",
        parentId: ids.building,
      }),
    } as never);

    expect(res).toBeInstanceOf(Response);
    const location = ((res as Response).headers.get("location") ?? "").replace("/locations/", "");
    expect((res as Response).status).toBe(302);
    expect(location).not.toBe("");

    const row = await db.location.findUnique({ where: { id: location } });
    expect(row?.name).toBe(`${RUN} neu`);
    expect(row?.kind).toBe("STORAGE");
    // The parent came from the form and was validated by the domain, not by the route.
    expect(row?.parentId).toBe(ids.building);
    created.push(location);
  });

  it("an invalid form returns field errors and writes NO row", async () => {
    const before = await db.location.count({ where: { name: { startsWith: RUN } } });
    const res = await newRoute.action({
      request: req("http://localhost/locations/new", { name: "", kind: "ROOM" }),
    } as never);

    expect(res).not.toBeInstanceOf(Response);
    expect((res as { fieldErrors?: Record<string, string[]> }).fieldErrors?.name?.[0]).toBeTruthy();
    // Counted over every fixture-prefixed row, not a name the test never
    // writes — an assertion scoped to a name no code path can produce passes
    // whether or not the route validated anything.
    expect(await db.location.count({ where: { name: { startsWith: RUN } } })).toBe(before);
  });

  it("?parent= preselects only a REAL parent — a stale id must not silently create at the root", async () => {
    const data = (await newRoute.loader({
      request: new Request("http://localhost/locations/new?parent=not-a-real-id"),
    } as never)) as { defaultParentId: string | null };
    expect(data.defaultParentId).toBeNull();

    const real = (await newRoute.loader({
      request: new Request(`http://localhost/locations/new?parent=${ids.building}`),
    } as never)) as { defaultParentId: string | null };
    expect(real.defaultParentId).toBe(ids.building);
  });
});

describe("locations edit action", () => {
  const edit = (id: string, body: Record<string, string>) =>
    editRoute.action({
      request: req(`http://localhost/locations/${id}/edit`, body),
      params: { id },
    } as never);

  it("updates through the domain and redirects back to the node", async () => {
    const res = await edit(ids.roomRoot, {
      name: `${RUN} umbenannt`,
      kind: "ROOM",
      code: "",
      address: "",
      description: "",
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    const row = await db.location.findUnique({ where: { id: ids.roomRoot } });
    expect(row?.name).toBe(`${RUN} umbenannt`);
  });

  it("a move into the node's OWN SUBTREE is refused inline — not a 500, and nothing is written", async () => {
    // ${RUN}_bld has the room under it, so building → room is a loop.
    const before = await auditCount();
    const res = await edit(ids.building, { _action: "move", parentId: ids.room });

    expect(res).not.toBeInstanceOf(Response);
    const data = res as { fieldErrors?: Record<string, string[]>; formErrors?: string[] };
    expect(data.fieldErrors?.parentId?.[0]).toBeTruthy();

    // The edge is unchanged, and the refusal wrote NO audit row — "nothing
    // happened" is not an event. This is the assertion that survives
    // the route layer, where a bare field-error check would not.
    const row = await db.location.findUnique({ where: { id: ids.building } });
    expect(row?.parentId).toBe(ids.site);
    expect(await auditCount()).toBe(before);
  });

  it("a legal move succeeds and the subtree follows", async () => {
    const res = await edit(ids.roomRoot, { _action: "move", parentId: ids.building });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);

    const row = await db.location.findUnique({ where: { id: ids.roomRoot } });
    expect(row?.parentId).toBe(ids.building);

    // Put it back, so the "scoped to the node" test above keeps its shape.
    await edit(ids.roomRoot, { _action: "move", parentId: "" });
  });

  it("deleting a node that still has children is refused inline, with the child count, and deletes nothing", async () => {
    const before = await auditCount();
    const res = await edit(ids.building, { _action: "delete" });

    expect(res).not.toBeInstanceOf(Response);
    const data = res as { formErrors?: string[] };
    // The child-count message lives in formErrors — the channel with no field to
    // attach to. Dropping it would render the refusal as silence.
    expect(data.formErrors?.[0]).toMatch(/1/);

    expect(await db.location.findUnique({ where: { id: ids.building } })).not.toBeNull();
    expect(await auditCount()).toBe(before);
  });
});

// ── Criterion (4): /m/locations is read-only and shares the query module.

describe("m.locations index", () => {
  it("exports NO action — the mobile surface is read-only by design", () => {
    expect("action" in mobileRoute).toBe(false);
  });

  it("reads the same tree as the desktop surface", async () => {
    const data = (await mobileRoute.loader({
      request: new Request("http://localhost/m/locations"),
    } as never)) as {
      nodes: Array<{ id: string; depth: number }>;
    };
    const nodes = idSet(data.nodes);
    expect(nodes.has(ids.site)).toBe(true);
    expect(nodes.has(ids.building)).toBe(true);
    expect(nodes.has(ids.room)).toBe(true);
  });
});
