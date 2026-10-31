import { afterAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { db } from "~/lib/db.server";
import { loader } from "~/routes/api.search/route";
import { runSearch } from "~/routes/api.search/search.server";

/**
 * T-CMD — api.search loader + runSearch helper.
 *
 * Seeds a room, an equipment instance and a ticket under a unique run prefix,
 * then asserts the search returns them with the right {type,href} shape. Also
 * covers the length guard (too-short → []) and the auth guard (an anonymous
 * request is redirected by requireUser). Cleanup deletes only OUR rows; the
 * ActivityLog is append-only, so we never touch it, and to avoid its guard
 * trigger the ticket is created directly via Prisma (no audit row written).
 *
 * **The identifier arm extended this file; it did not replace it.** The six pre-existing
 * cases above the marker are unchanged from before the identifier arm,
 * and criterion (4) is *extended, never replaced* — so the case count only
 * grows, and the old arms are pinned by the old cases rather than by a new
 * assertion about them. `afterAll` keeps its empty-filter guard, and now also
 * removes this tick's stock and location rows.
 *
 * ⚠️ **Every assertion below is id-scoped to a row this file created.** The dev
 * database is shared and seeded, and seeded rows are dated relative to `now`, so
 * an unscoped count or a `toHaveLength` over "inventory-item" results measures
 * the seed as much as the fixture. Where a test compares two sets, both sides
 * are narrowed the same way — comparing a query scoped one way against a
 * reference scoped another fails for the wrong reason.
 *
 * The `RUN` prefix carries `Date.now()`, so no seeded row can contain it: the
 * one place the file asserts on a whole result list is safe for that reason and
 * not by accident.
 */

const RUN = `cmdsearch_${Date.now()}`;
const ROOM_TOKEN = `${RUN}_room`;
const EQUIP_TAG = `${RUN}_tag`;
const TICKET_TITLE = `${RUN}_ticket title`;
/**
 * ⚠️ **Every serial/sku constant below is used by exactly ONE test, and that
 * is load-bearing rather than tidy.** `serial` and `sku` are `@@unique`, and
 * `afterAll` cleanup means test 1's row is **still in the database** when test 2
 * mints its own — so two tests sharing one module-level token collide on the
 * unique index and the second one dies in `create` before it can assert anything.
 * The first version of this file did exactly that and failed that way.
 */
const SERIAL_ONE = `${RUN}_sn_one`;
/** a serial that is a *prefix* of the other item's — the exact-match trap. */
const SERIAL_BASE = `${RUN}_sn_base`;
const SERIAL_EXT = `${RUN}_sn_base_extra`;
const SKU_TOKEN = `${RUN}_sku`;

let campusId: string;
let roomId: string;
let roomSlug: string;
let equipmentId: string;
let ticketId: string;
let locationId: string;
const stockIds: string[] = [];

afterAll(async () => {
  // Guard against unassigned ids: `{ id: undefined }` is an EMPTY Prisma filter
  // and would deleteMany the whole table on the shared dev DB if setup bailed
  // before an id was set. `in` with a filtered array deletes nothing instead.
  const ids = (id: string | undefined) => ({ id: { in: [id].filter(Boolean) as string[] } });
  await db.ticket.deleteMany({ where: ids(ticketId) });
  await db.equipment.deleteMany({ where: ids(equipmentId) });
  await db.inventoryItem.deleteMany({ where: { id: { in: stockIds } } });
  await db.room.deleteMany({ where: ids(roomId) });
  // Location last: the stock rows point at it (onDelete: SetNull would survive a
  // bad order, but the fixture should not rely on a cascade to clean up after it).
  await db.location.deleteMany({ where: ids(locationId) });
  await db.campus.deleteMany({ where: ids(campusId) });
  await db.$disconnect();
});

describe("runSearch", () => {
  it("returns [] for a query shorter than 2 chars", async () => {
    expect(await runSearch("a")).toEqual([]);
    expect(await runSearch(" ")).toEqual([]);
  });

  it("returns [] for a query longer than 100 chars", async () => {
    expect(await runSearch("x".repeat(101))).toEqual([]);
  });

  it("finds a seeded room with the /rooms/:slug href shape", async () => {
    const campus = await db.campus.create({
      data: { name: `${RUN} Campus`, slug: `${RUN}-campus` },
    });
    campusId = campus.id;
    const room = await db.room.create({
      data: {
        name: ROOM_TOKEN,
        slug: `${RUN}-room`,
        campusId: campus.id,
        status: "ALL_GOOD",
      },
    });
    roomId = room.id;
    roomSlug = room.slug;

    const results = await runSearch(ROOM_TOKEN);
    const hit = results.find((r) => r.type === "room" && r.id === roomId);
    expect(hit).toBeDefined();
    expect(hit?.href).toBe(`/rooms/${roomSlug}`);
    expect(hit?.label).toBe(ROOM_TOKEN);
  });

  it("finds a seeded equipment instance by asset tag with the /inventory/:id href shape", async () => {
    const equipment = await db.equipment.create({
      data: {
        name: `${RUN} Beamer`,
        assetTag: EQUIP_TAG,
        category: "PROJECTOR",
        status: "OPERATIONAL",
        mobility: "FIXED",
        roomId,
      },
    });
    equipmentId = equipment.id;

    const results = await runSearch(EQUIP_TAG);
    const hit = results.find((r) => r.type === "equipment" && r.id === equipmentId);
    expect(hit).toBeDefined();
    expect(hit?.href).toBe(`/inventory/${equipmentId}`);
  });

  it("finds a seeded ticket by title with the /tickets/:id href shape", async () => {
    const ticket = await db.ticket.create({
      data: {
        type: "INCIDENT",
        status: "OPEN",
        title: TICKET_TITLE,
        roomId,
        occurredAt: new Date(),
      },
    });
    ticketId = ticket.id;

    const results = await runSearch(TICKET_TITLE);
    const hit = results.find((r) => r.type === "ticket" && r.id === ticketId);
    expect(hit).toBeDefined();
    expect(hit?.href).toBe(`/tickets/${ticketId}`);
    expect(hit?.label).toBe(TICKET_TITLE);
  });
});

describe("loader auth guard", () => {
  it("redirects an unauthenticated request to /login", async () => {
    const request = new Request("http://localhost/api/search?q=beamer");
    try {
      // The loader only reads `request`; the rest of RR's LoaderArgs shape is
      // irrelevant to the auth guard under test, so a minimal cast is fine.
      await loader({ request } as Parameters<typeof loader>[0]);
      throw new Error("expected the loader to throw a redirect");
    } catch (e) {
      // requireUser throws a redirect Response for anonymous callers.
      expect(e).toBeInstanceOf(Response);
      const res = e as Response;
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The identifier arm. The type + the href; the
// four existing arms are untouched and the new one is APPENDED;
// exact, not contains, with the negative control the row demands.
// ─────────────────────────────────────────────────────────────────────────────

/** One `STORAGE` location, so the sublabel assertion has a real name to carry. */
async function seedLocation(): Promise<string> {
  if (locationId) return locationId;
  const loc = await db.location.create({
    data: { name: `${RUN} Lagerhalle`, kind: "STORAGE" },
  });
  locationId = loc.id;
  return loc.id;
}

describe("runSearch — the inventory-item arm (type and href)", () => {
  it("finds a stock item by its serial and links it into the stock namespace", async () => {
    const location = await seedLocation();
    const item = await db.inventoryItem.create({
      data: { name: `${RUN} Funkmikrofon`, serial: SERIAL_ONE, locationId: location },
    });
    stockIds.push(item.id);

    const results = await runSearch(SERIAL_ONE);
    const hits = results.filter((r) => r.type === "inventory-item" && r.id === item.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.href).toBe(`/inventory/stock/${item.id}`);
    expect(hits[0]?.label).toBe(`${RUN} Funkmikrofon`);
    // The sublabel is the location, not the serial the user just typed back at
    // them — "which box is it" is the next question.
    expect(hits[0]?.sublabel).toBe(`${RUN} Lagerhalle`);
  });

  it("finds a stock item by its sku as well, and links it the same way", async () => {
    const item = await db.inventoryItem.create({
      data: { name: `${RUN} Kabel`, sku: SKU_TOKEN },
    });
    stockIds.push(item.id);

    const results = await runSearch(SKU_TOKEN);
    const hits = results.filter((r) => r.type === "inventory-item" && r.id === item.id);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.href).toBe(`/inventory/stock/${item.id}`);
  });

  it("returns the item ONCE when its serial and sku are the same string", async () => {
    // Two lookups, one row. The palette keys on `type:id`, so a duplicate would
    // also break React's list — and `sku === serial` is legal, nothing forbids it.
    const both = `${RUN}_same`;
    const item = await db.inventoryItem.create({
      data: { name: `${RUN} Doppelt`, serial: both, sku: both },
    });
    stockIds.push(item.id);

    const results = await runSearch(both);
    expect(results.filter((r) => r.type === "inventory-item" && r.id === item.id)).toHaveLength(1);
  });

  it("a stock item with no location is still found, with a null sublabel", async () => {
    // The other branch of `sublabel: item.location?.name ?? null`. Test 1 above
    // pins the located half; a change that turned a missing location into a
    // dropped result, or into the string "null", passes test 1 and fails here.
    const item = await db.inventoryItem.create({
      data: { name: `${RUN} Allein`, serial: `${RUN}_lonely` },
    });
    stockIds.push(item.id);

    const results = await runSearch(`${RUN}_lonely`);
    const mine = results.filter((r) => r.type === "inventory-item" && r.id === item.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.sublabel).toBeNull();
  });
});

describe("runSearch — exact, not contains", () => {
  it("does NOT match a prefix of a serial, nor a serial that is a substring of another", async () => {
    const base = await db.inventoryItem.create({
      data: { name: `${RUN} Basis`, serial: SERIAL_BASE },
    });
    const ext = await db.inventoryItem.create({
      data: { name: `${RUN} Erweitert`, serial: SERIAL_EXT },
    });
    stockIds.push(base.id, ext.id);

    // ⚠️ **Both sides of the comparison are narrowed to THIS test's two ids.** An
    // unscoped "no inventory-item results" assertion would also be measuring the
    // shared dev seed, and a wider filter would make it pass for the wrong reason.
    const stockHits = async (query: string) => {
      const results = await runSearch(query);
      return results
        .filter((r) => r.type === "inventory-item" && (r.id === base.id || r.id === ext.id))
        .map((r) => r.id);
    };

    // The exact serial: ONE row, and specifically the base — not the longer one
    // whose serial *contains* it. This is the row's own negative control, and it
    // is an exact ordered list precisely so a `contains` filter (which would
    // return both, base first) turns it red.
    expect(await stockHits(SERIAL_BASE)).toEqual([base.id]);
    // A prefix of a real serial. Under `contains` this would have matched, and
    // a technician would have been handed the wrong device.
    expect(await stockHits(SERIAL_BASE.slice(0, -1))).toEqual([]);
    // The tail of the longer serial — a substring of it under `contains`, and a
    // prefix of nothing. The third distinct direction the filter gets wrong.
    expect(await stockHits(SERIAL_EXT.slice(SERIAL_BASE.length))).toEqual([]);
  });

  it("does NOT match a stock item by its NAME — the arm is identifiers only", async () => {
    // A deliberate scope decision, pinned so a later slice that adds a
    // name arm has to meet it rather than slip in unnoticed. `listStock` already
    // does `contains` on the name for the stock page; the palette's job here is
    // the identifier, which the page's own search box cannot do.
    const name = `${RUN}_NurName`;
    const item = await db.inventoryItem.create({
      data: { name, serial: `${RUN}_has_serial` },
    });
    stockIds.push(item.id);

    const results = await runSearch(name);
    expect(results.filter((r) => r.type === "inventory-item" && r.id === item.id)).toEqual([]);
    // …and the same query DOES find it by its serial, so the arm is alive and
    // the assertion above is not passing because the arm is dead.
    const bySerial = await runSearch(`${RUN}_has_serial`);
    expect(bySerial.filter((r) => r.type === "inventory-item" && r.id === item.id)).toHaveLength(1);
  });
});

describe("runSearch — the four existing arms are untouched, the fifth is appended (criterion 2)", () => {
  it("returns room, ticket, event, equipment and then inventory-item, in that order", async () => {
    // One token, one row of each kind, so the ORDER is an assertion rather than
    // an accident of four independent `contains` filters. The new arm is last:
    // it is the only one that is an equality lookup, and putting an equality
    // result ahead of four ranked ones would reorder the palette for every
    // existing query.
    const token = `${RUN}_all`;
    const campus = await db.campus.create({
      data: { name: `${token} Campus`, slug: `${token}-campus` },
    });
    const room = await db.room.create({
      data: { name: token, slug: `${token}-room`, campusId: campus.id, status: "ALL_GOOD" },
    });
    const equipment = await db.equipment.create({
      data: {
        name: token,
        category: "PROJECTOR",
        status: "OPERATIONAL",
        mobility: "FIXED",
        roomId: room.id,
      },
    });
    const ticket = await db.ticket.create({
      data: {
        type: "INCIDENT",
        status: "OPEN",
        title: token,
        roomId: room.id,
        occurredAt: new Date(),
      },
    });
    const event = await db.event.create({
      data: {
        title: token,
        status: "PLANNED",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 3600_000),
      },
    });
    const item = await db.inventoryItem.create({ data: { name: token, serial: token } });
    stockIds.push(item.id);

    // Local cleanup: this file's `afterAll` owns the RUN-prefixed rows, and these
    // five are all of those. `db.ticket.deleteMany` runs first because
    // `Ticket.roomId` is Restrict; `db.event` has no room link, so it goes last.
    try {
      const results = await runSearch(token);
      const mine = new Set([room.id, ticket.id, event.id, equipment.id, item.id]);
      const ordered = results.filter((r) => mine.has(r.id)).map((r) => r.type);
      expect(ordered).toEqual(["room", "ticket", "event", "equipment", "inventory-item"]);
    } finally {
      await db.ticket.deleteMany({ where: { id: ticket.id } });
      await db.equipment.deleteMany({ where: { id: equipment.id } });
      await db.event.deleteMany({ where: { id: event.id } });
      await db.room.deleteMany({ where: { id: room.id } });
      await db.campus.deleteMany({ where: { id: campus.id } });
    }
  });
});

/**
 * The href is a *string*, and a string is not a URL until the router has agreed
 * it is one. `/inventory/stock` is a static segment; a static segment with no
 * route behind it does not 404, it falls through to the dynamic sibling
 * `/inventory/:id` and renders the **Equipment detail page** — silently, and
 * with a real page rather than an error. A slice
 * that pointed the stock arm at `/inventory/${id}` would leave
 * `test/routes/route-resolution.test.ts` perfectly green, because that guard
 * compares route FILES and a search result is not a route file.
 *
 * So the assertion is made here, on the value `runSearch` actually produced,
 * through the same instrument the route tests use. Reused rather than reimplemented: a
 * second router harness would be a second thing to keep honest.
 */
type AppDirectoryGlobal = { __reactRouterAppDirectory?: string };
(globalThis as AppDirectoryGlobal).__reactRouterAppDirectory = fileURLToPath(
  new URL("../../../../app", import.meta.url),
);

const { flatRoutes } = await import("@react-router/fs-routes");
const { matchRoutes } = await import("react-router");

type RouteEntry = { id?: string; path?: string; index?: boolean; children?: RouteEntry[] };

const ROUTES: RouteEntry[] = (await flatRoutes()) as RouteEntry[];

/** The winning route FILE for a URL, or `null` when nothing matches. */
const winnerOf = (url: string): string | null => {
  const match = matchRoutes(ROUTES as never, url) as Array<{ route: { id?: string } }> | null;
  return match?.at(-1)?.route.id ?? null;
};

describe("runSearch — the stock href is a URL the router agrees with", () => {
  it("resolves to the stock detail route, NOT the equipment detail route", async () => {
    const item = await db.inventoryItem.create({
      data: { name: `${RUN} Router`, serial: `${RUN}_router` },
    });
    stockIds.push(item.id);

    const results = await runSearch(`${RUN}_router`);
    const hit = results.find((r) => r.type === "inventory-item" && r.id === item.id);
    expect(hit).toBeDefined();

    expect(winnerOf(hit!.href)).toBe("routes/_desktop.inventory.stock.$id");
    // The control: the URL this guard exists to catch resolves to a DIFFERENT,
    // equally real page. Without it, the assertion above would also pass if the
    // instrument simply reported the same winner for everything.
    expect(winnerOf(`/inventory/${item.id}`)).toBe("routes/_desktop.inventory.$id");
  });
});
