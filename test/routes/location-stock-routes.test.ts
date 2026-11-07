import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";

/**
 * Loader tests for the stock panel on `/locations/:id`.
 *
 * ⚠️ **This is not a render test.** Vitest runs in `node` with no
 * DOM, so the exported `loader` is called directly against the real dev database.
 * What is provable here is that the loader computes the right *set* and that the
 * files which draw it cannot quietly reach past the domain. Whether the panel
 * *draws* is an end-to-end concern (Playwright), the same line the other route tests draw.
 *
 * **Why the structural tests are here at all.** Three of the five criteria are
 * about things a green suite cannot see on its own: the import boundary (1), the
 * absence of a second count query (1), and the mobile surface not growing (4).
 * Each one is asserted over source text — and each extractor carries its own
 * **control**, because an assertion over a file that cannot be read is a green that
 * no defect can produce.
 *
 * `requireUser` is mocked to a fixed actor; every other export of
 * `~/lib/auth.server` is preserved.
 *
 * Fixtures are written with the client directly, NOT through the domain: the tests
 * need **known ids** to name rows, and the panel is a read — a fixture that went
 * through a mutation would write audit rows the count assertions would then
 * measure.
 */
const RUN = `loc_stock_${Date.now()}`;

const TEST_USER: AuthUser = {
  id: null as unknown as string,
  name: "Panel Tester",
  email: `${RUN}@test.local`,
  initials: "PT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => TEST_USER) };
});

// Imported AFTER the mock so the route modules see the mocked requireUser.
const detailRoute = await import("~/routes/_desktop.locations.$id/route");
// The stock list loader, imported here and nowhere else modified: the panel links into the
// stock namespace, and a link whose target shows something else is a lying URL. Since
// `/inventory/stock` became a redirect, the loader lives on the tabbed inventory page
// (`/inventory?tab=stock`).
const stockIndexRoute = await import("~/routes/_desktop.inventory._index/route");

/** ── Fixtures ─────────────────────────────────────────────────────────────── */

/**
 * A hierarchy with a stocked **building** under a site, and a sibling store:
 *
 *   ${RUN}_site        SITE
 *     ${RUN}_building  BUILDING      ← 1 item of its own; its child holds 2 more
 *       ${RUN}_room    ROOM          ← the 2
 *     ${RUN}_store     STORAGE       ← 1, a sibling: not a descendant of the building
 *   ${RUN}_outside    ROOM          ← unrelated root
 *
 * That shape is the point of the test: a building whose *rooms* hold
 * stock must not read as a stocked building, and must not read as empty either.
 */
const loc = {
  site: `${RUN}_site`,
  building: `${RUN}_building`,
  room: `${RUN}_room`,
  store: `${RUN}_store`,
  outside: `${RUN}_outside`,
};

const item = {
  inRoom1: `${RUN}_in_room_1`,
  inRoom2: `${RUN}_in_room_2`,
  inBuilding: `${RUN}_in_building`,
  inStore: `${RUN}_in_store`,
  /** `locationId = null`: stock that is not assigned to any location. */
  loose: `${RUN}_loose`,
};

const vendorId = `${RUN}_vendor`;

const itemIds = Object.values(item);
const locationIds = Object.values(loc);

beforeAll(async () => {
  await db.location.createMany({
    data: [
      { id: loc.site, name: `${RUN} Campus`, kind: "SITE" },
      { id: loc.building, name: `${RUN} Gebäude`, kind: "BUILDING", parentId: loc.site },
      { id: loc.room, name: `${RUN} Hörsaal`, kind: "ROOM", parentId: loc.building },
      { id: loc.store, name: `${RUN} Lager`, kind: "STORAGE", parentId: loc.site },
      { id: loc.outside, name: `${RUN} fremder Raum`, kind: "ROOM" },
    ],
  });
  await db.vendor.create({ data: { id: vendorId, name: `${RUN} Lieferant GmbH` } });
  await db.inventoryItem.createMany({
    data: [
      {
        id: item.inRoom1,
        name: `${RUN} Kabel 5m`,
        quantity: 4,
        unit: "Stk.",
        locationId: loc.room,
      },
      {
        id: item.inRoom2,
        name: `${RUN} Adapter`,
        quantity: 12,
        unit: "Stk.",
        // A serial on one row and not the other: the panel draws both spellings, and
        // a fixture where every row has one cannot tell a fallback from a field.
        serial: `${RUN}-SER-A`,
        locationId: loc.room,
      },
      // The building's own item — the panel's number is 1, while its subtree holds 2.
      {
        id: item.inBuilding,
        name: `${RUN} Werkzeugkoffer`,
        quantity: 1,
        unit: "Stk.",
        locationId: loc.building,
        vendorId,
      },
      {
        id: item.inStore,
        name: `${RUN} Klebeband`,
        quantity: 20,
        unit: "Rollen",
        locationId: loc.store,
      },
      { id: item.loose, name: `${RUN} Kabelbinder`, quantity: 500, unit: "Stk.", locationId: null },
    ],
  });
});

afterAll(async () => {
  // Stock first: `InventoryItem.locationId` is `SetNull`, so the order is about the
  // *assertions* staying honest, not about a foreign key. Locations need the
  // detach first — `Location.parentId` is `Restrict`, the same refusal the location pages render.
  await db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.location.updateMany({ where: { id: { in: locationIds } }, data: { parentId: null } });
  await db.location.deleteMany({ where: { id: { in: locationIds } } });
  await db.$disconnect();
});

/** ── Helpers ──────────────────────────────────────────────────────────────── */

type StockRow = {
  id: string;
  name: string;
  quantity: number;
  unit: string | null;
  sku: string | null;
  serial: string | null;
  vendor: { id: string; name: string } | null;
  location: { id: string; name: string; kind: string } | null;
};

type DetailData = {
  location: { id: string };
  descendants: Array<{ id: string; depth: number }>;
  stock: StockRow[];
};

const loadDetail = async (id: string): Promise<DetailData> =>
  (await detailRoute.loader({ params: { id } } as never)) as DetailData;

const loadStockList = async (query = "") => {
  const extra = query.startsWith("?") ? `&${query.slice(1)}` : query;
  const data = (await stockIndexRoute.loader({
    request: new Request(`http://localhost/inventory?tab=stock${extra}`),
  } as never)) as {
    stock: {
      items: Array<{ id: string; location: { id: string } | null }>;
      filters: { locationId: string };
    };
  };
  return data.stock;
};

const idSet = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The two files under test — the scope of every structural assertion below. */
const ROUTE_FILE = "../../app/routes/_desktop.locations.$id/route.tsx";
const PANEL_FILE = "../../app/components/locations/location-stock.tsx";

/**
 * Import specifiers of a source file — **a hole in the import-boundary net, closed for these two files.**
 *
 * The broader net matches `/(?:from|import)\s+["']…/`, which requires a quote after the keyword, so `await import("~/lib/db.server")` — the
 * next character is `(` — is invisible to it: a banned module imported that way passes. That net is not this file's to repair, and it is still the one that runs
 * in CI; these two files hold themselves to the stricter rule, so the boundary is verified by a test instead of by reading.
 *
 * The `\(?` is the whole difference, and the first test below proves it: a dynamic
 * import is matched here, which is precisely what the older net cannot see.
 */
const specifiersOf = (source: string): string[] =>
  [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);

const BANNED = ["~/lib/db.server", "~/generated/prisma/client"];

// ── The boundary, and the count that is not a second query.

describe("the panel reads stock through the domain module", () => {
  it("CONTROL: the extractor sees the dynamic import spelling", () => {
    // If this test could not fail, every assertion built on `specifiersOf` would be
    // green for the same reason the older net is green: the file was never read.
    const dynamic = 'const { db } = await import("~/lib/db.server");';
    const staticFrom = 'import { listStockAtLocation } from "~/domains/inventory/x";';
    const staticBare = 'import "~/generated/prisma/client";';
    const typeOnly = 'import type { InventoryItem } from "~/generated/prisma/client";';

    expect(specifiersOf(dynamic)).toContain("~/lib/db.server");
    expect(specifiersOf(staticFrom)).toContain("~/domains/inventory/x");
    expect(specifiersOf(staticBare)).toContain("~/generated/prisma/client");
    expect(specifiersOf(typeOnly)).toContain("~/generated/prisma/client");
    // …and it is not a `/db\./` scan in disguise: prose naming the module is not a
    // hit, which is the trap a bare keyword scan falls into when it reads its own explanation.
    expect(specifiersOf("this route imports the db module itself")).toEqual([]);
  });

  it("neither file under test reaches for the client or the db module", () => {
    for (const rel of [ROUTE_FILE, PANEL_FILE]) {
      const specifiers = specifiersOf(src(rel));
      for (const banned of BANNED)
        expect(specifiers, `${rel} must not import ${banned}`).not.toContain(banned);
      expect(
        specifiers.some((s) => s.startsWith("@prisma/client")),
        rel,
      ).toBe(false);
    }
    // And the positive half, so a file that imported nothing at all cannot pass:
    // the route reaches the domain modules, and does so for stock specifically.
    const routeSpecifiers = specifiersOf(src(ROUTE_FILE));
    expect(routeSpecifiers.filter((s) => s.startsWith("~/domains/"))).not.toHaveLength(0);
    expect(routeSpecifiers).toContain("~/domains/inventory/inventory.stock.queries.server");
    expect(routeSpecifiers).toContain("~/components/locations/location-stock");
  });

  it("the loader asks the query for THIS node, and the panel's number is the rows it draws", () => {
    // The first check names the function; the second checks the argument. Both are
    // structural because a behavioural test cannot tell "the same set" from "the
    // same set for the wrong reason" — a subtree walk returns a superset, not a
    // different set, when the node itself happens to be stocked.
    const route = src(ROUTE_FILE);
    expect(route).toMatch(/listStockAtLocation\(\s*location\.id\s*\)/);
    // The heading is the array it renders, and no second count function is called.
    expect(src(PANEL_FILE)).toMatch(/\{\s*items\.length\s*\}/);
    for (const rel of [ROUTE_FILE, PANEL_FILE]) {
      expect(src(rel), `${rel} must not call countStockAtLocation`).not.toMatch(
        /countStockAtLocation\s*\(/,
      );
    }
    // …and the function it is not calling really is there, with the `Tx` parameter
    // that a loader cannot produce. Without this the assertion above would also
    // pass if the export had been deleted, which is not the same finding.
    expect(src("../../app/domains/inventory/inventory.stock.queries.server.ts")).toMatch(
      /export async function countStockAtLocation\(\s*tx:\s*Tx\s*,/,
    );
  });
});

// ── Criteria (2) and (3): the count is AT this node, and only at this node.

describe("criteria (2) + (3) — a stocked building reads its own stock, not its subtree's", () => {
  it("counts the items AT the node; the subtree's items are not folded in", async () => {
    const data = await loadDetail(loc.building);
    // The node has descendants (so this is not an empty-because-unstocked page)…
    expect(idSet(data.descendants).has(loc.room)).toBe(true);
    // …its own subtree really holds stock…
    expect(await db.inventoryItem.count({ where: { locationId: loc.room } })).toBe(2);
    // …and the panel still says 1, and names only its own row.
    expect(data.stock).toHaveLength(1);
    expect(idSet(data.stock)).toEqual(new Set([item.inBuilding]));
  });

  it("a leaf's panel holds that leaf's items, and none of its ancestors'", async () => {
    const data = await loadDetail(loc.room);
    expect(idSet(data.stock)).toEqual(new Set([item.inRoom1, item.inRoom2]));
    // The ancestor's own item is not pulled down the tree.
    expect(idSet(data.stock).has(item.inBuilding)).toBe(false);
  });

  it("a sibling is not a descendant and not this node's stock", async () => {
    expect(idSet((await loadDetail(loc.building)).stock).has(item.inStore)).toBe(false);
    expect(idSet((await loadDetail(loc.building)).descendants).has(loc.store)).toBe(false);
    expect(idSet((await loadDetail(loc.store)).stock)).toEqual(new Set([item.inStore]));
  });

  it("every row the panel draws points at this node — the number cannot count a join", async () => {
    // The number is `stock.length`, so a row from anywhere else would silently
    // inflate it. Asserted per row rather than on the total, which is the only form
    // in which a wrong row and a right total are distinguishable.
    for (const id of [loc.site, loc.building, loc.room, loc.store, loc.outside]) {
      const data = await loadDetail(id);
      expect(data.stock.length).toBe(idSet(data.stock).size);
      for (const row of data.stock) expect(row.location?.id, `${row.id} under ${id}`).toBe(id);
    }
  });

  it("an item assigned nowhere is in NO location's panel — and is visible somewhere", async () => {
    for (const id of locationIds) {
      expect(idSet((await loadDetail(id)).stock).has(item.loose), `loose item under ${id}`).toBe(
        false,
      );
    }
    // The other half of the stock list contract, and the panel's own goal ("an item assigned
    // nowhere is not silently invisible"): the panel never claims it, and the stock
    // list still shows it. An exclusion nobody can find the excluded thing in is
    // a different defect from a wrong count.
    const all = await loadStockList();
    expect(idSet(all.items).has(item.loose)).toBe(true);
    // The site holds nothing of its own while its children do — the "0 items" page
    // that would be wrong if the count meant the subtree.
    expect((await loadDetail(loc.site)).stock).toEqual([]);
  });

  it("the same URL returns the same rows, in the same order", async () => {
    const first = await loadDetail(loc.room);
    const second = await loadDetail(loc.room);
    expect(second.stock.map((r) => r.id)).toEqual(first.stock.map((r) => r.id));
    // A name that sorts before the other one, so the order is the query's and not
    // the insertion order the fixture happens to have.
    expect(first.stock.map((r) => r.name)).toEqual([`${RUN} Adapter`, `${RUN} Kabel 5m`]);
  });
});

// ── Nothing else moves, and the link the panel offers is true.

describe("the mobile surface stays read-only, and the cross-link does not lie", () => {
  it("/m/locations does not grow the panel", () => {
    const mobile = src("../../app/routes/m.locations._index/route.tsx");
    expect(mobile).not.toContain("listStockAtLocation");
    expect(mobile).not.toContain("location-stock");
    // The panel is a component, so an import of it here is the only way it could
    // appear; the specifier check makes that explicit rather than trusting the name.
    expect(specifiersOf(mobile)).not.toContain("~/components/locations/location-stock");
  });

  it("the panel's 'Im Lager filtern' link leads here, plus the unassigned rows — and no other location's", async () => {
    // A cross-link that led to a different list is the same defect as the lying URL
    // parameter the stock list refuses to ship. The link the panel renders is
    // `/inventory/stock?location=<this node>`, so its target is checked here — and
    // ⚠️ **the target is deliberately NOT equal to the panel, and the first draft of
    // this test asserted that it was and failed.** `stockListOptionsSchema` defaults
    // `includeUnassigned` to **true** (`inventory.stock.schema.ts`, a
    // documented choice: "assigned nowhere is a stock state worth seeing"), so a
    // location-scoped stock list is `locationId = X OR locationId IS NULL`.
    //
    // That is what makes the panel's scope note a fact instead of a disclaimer: the
    // excluded rows are exactly the ones the link then shows, marked "Nicht
    // zugeordnet" (`stock-columns.tsx`). The stock list and the "flag does
    // bite … pinned by a test" are therefore both satisfied — by the *surface the
    // panel hands over to*, not by counting an unassigned row as being at this node.
    const panel = idSet((await loadDetail(loc.building)).stock);
    const filtered = await loadStockList(`?location=${loc.building}`);
    expect(filtered.filters.locationId).toBe(loc.building);

    const shown = idSet(filtered.items);
    for (const id of panel)
      expect(shown.has(id), `the panel's own row ${id} must be in the target`).toBe(true);
    // The extras are the unassigned rows and nothing else. Asserted as a property
    // over the rows, not as a count: the unassigned set is global (the seed and other
    // fixtures contribute to it), so an exact number here would be a foreign fact.
    for (const row of filtered.items) {
      expect(row.location === null || row.location.id === loc.building, `stray row ${row.id}`).toBe(
        true,
      );
    }
    expect(filtered.items.map((r) => r.id)).toContain(item.loose);
    // …and the filter is real: another location's items are absent, and the sibling's
    // and the child's would have been here had the parameter been dropped.
    expect(filtered.items.map((r) => r.id)).not.toContain(item.inStore);
    expect(filtered.items.map((r) => r.id)).not.toContain(item.inRoom1);
    expect(idSet((await loadStockList()).items)).toContain(item.inStore);
  });
});

// ── The loader shape, unchanged.

describe("the location loader contract still holds", () => {
  it("descendants are still rooted at the node and exclude it", async () => {
    const data = await loadDetail(loc.building);
    expect(idSet(data.descendants).has(loc.building)).toBe(false);
    expect([...idSet(data.descendants)]).toEqual([loc.room]);
    expect(data.descendants[0].depth).toBe(1);
  });

  it("an unknown id is still a 404, and a leaf is still not an error", async () => {
    const thrown = await (
      detailRoute.loader({ params: { id: `${RUN}_missing` } } as never) as Promise<unknown>
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    expect((await loadDetail(loc.outside)).stock).toEqual([]);
  });
});
