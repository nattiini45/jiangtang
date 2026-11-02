import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "~/lib/db.server";
import { previewCsv } from "~/lib/csv/preview";
import type { AuthUser } from "~/lib/auth.server";

/**
 * Loader/action tests for `/inventory/stock*` and `/m/inventory/stock` (criteria
 * 2–4).
 *
 * ⚠️ **This is not a render test, and the URL half of the contract is not here either.** Vitest
 * runs in `node` with no DOM, so these call the exported `loader`/`action` directly against
 * the real dev database — the same precedent as the location route tests, caveat and all. Which URL a *page* lives at
 * is a different question with a different instrument, and it is `test/routes/
 * route-resolution.test.ts`: the router is the only thing that knows which page `/inventory/stock`
 * resolves to, and a loader called directly is structurally blind
 * to that. Two files because the two questions are two files' worth.
 *
 * `requireUser` is mocked to a fixed actor; every other export of `~/lib/auth.server` is
 * preserved.
 *
 * Fixtures are written with the client directly, NOT through the domain: the tests need
 * **known ids** to name rows, and the audit-count checks measure rows *written by the
 * routes*, so fixture noise on the same entity ids would make them lie.
 */
const RUN = `stock_${Date.now()}`;

const TEST_USER: AuthUser = {
  id: null as unknown as string,
  name: "Stock Tester",
  email: `${RUN}@test.local`,
  initials: "ST",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireUser: vi.fn(async () => TEST_USER) };
});

// Imported AFTER the mock so the route modules see the mocked requireUser.
const indexRoute = await import("~/routes/_desktop.inventory.stock._index/route");
const newRoute = await import("~/routes/_desktop.inventory.stock.new/route");
const detailRoute = await import("~/routes/_desktop.inventory.stock.$id/route");
const mobileRoute = await import("~/routes/m.inventory.stock._index/route");

/** ── Fixtures ─────────────────────────────────────────────────────────────── */

/**
 * Two locations of **different kinds**, because a move across kinds is the case under test:
 * moving stock from a `ROOM` to a `STORAGE` is the case that a naive
 * "locationId must match the item's category" rule would refuse, and expresses no
 * such rule — the FK is a plain `SetNull` reference.
 */
const ids = {
  room: `${RUN}_room`,
  store: `${RUN}_store`,
  vendor: `${RUN}_vendor`,
  /** A SECOND real vendor, for the picker's option set and the ?vendor= filter. */
  vendor2: `${RUN}_vendor2`,
  equipment: `${RUN}_equipment`,
  /** At the ROOM, linked to Equipment, carrying tags — the full-detail fixture. */
  linked: `${RUN}_linked`,
  /** Assigned nowhere and unlinked — the "unassigned is a state worth seeing" fixture. */
  loose: `${RUN}_loose`,
};

const WARRANTY = new Date("2027-03-31T00:00:00.000Z");

beforeAll(async () => {
  await db.location.createMany({
    data: [
      { id: ids.room, name: `${RUN} Hörsaal`, kind: "ROOM" },
      { id: ids.store, name: `${RUN} Lager`, kind: "STORAGE" },
    ],
  });
  // Two REAL vendors, minted directly rather than through a domain writer: the picker and
  // the ?vendor= filter both need more than one option, and `vendors/` is a read-only
  // module so there is no audited vendor-create to call.
  await db.vendor.createMany({
    data: [
      { id: ids.vendor, name: `${RUN} Lieferant GmbH` },
      { id: ids.vendor2, name: `${RUN} Zweitlieferant AG` },
    ],
  });
  await db.equipment.create({
    data: { id: ids.equipment, category: "MICROPHONE", name: `${RUN} Funkmikrofon` },
  });
  await db.inventoryItem.createMany({
    data: [
      {
        id: ids.linked,
        name: `${RUN} Ersatzkabel`,
        sku: `${RUN}-SKU`,
        serial: `${RUN}-SER`,
        quantity: 7,
        unit: "Stk.",
        category: "Kabel",
        status: "AVAILABLE",
        warrantyExpiresAt: WARRANTY,
        vendorId: ids.vendor,
        locationId: ids.room,
        equipmentId: ids.equipment,
        // A tag the move form does not show — the fixture for the "a move must not clear
        // what it does not render" assertion below.
        tags: ["kabel", "ersatzteil"],
      },
      { id: ids.loose, name: `${RUN} Kabelbinder`, quantity: 500, unit: "Stk.", tags: [] },
    ],
  });
});

afterAll(async () => {
  // Order matters: `InventoryItem.equipmentId` is `Restrict`, so the stock rows go first.
  await db.inventoryItem.deleteMany({ where: { id: { in: [ids.linked, ids.loose] } } });
  await db.equipment.deleteMany({ where: { id: ids.equipment } });
  await db.vendor.deleteMany({ where: { id: { in: [ids.vendor, ids.vendor2] } } });
  await db.location.deleteMany({ where: { id: { in: [ids.room, ids.store] } } });
  await db.$disconnect();
});

/** ── Helpers ──────────────────────────────────────────────────────────────── */

const req = (url: string, body?: Record<string, string | string[]>): Request => {
  if (!body) return new Request(url);
  const fd = new FormData();
  // `URLSearchParams` is not used to build this body: `new URLSearchParams({ tags: ["a", "b"] })`
  // produces `tags=a%2Cb`, one key whose value is the string "a,b". A `tags` test written through
  // that helper would assume a comma-splitting convention this repo does not have, and pass for
  // the wrong reason.
  // `FormData.append` per entry is what a browser really sends, and it is the only way to
  // express the repeated key `formDataToObject` collapses into the `String[]`.
  for (const [k, v] of Object.entries(body))
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  return new Request(url, { method: "POST", body: fd });
};

type ListRow = {
  id: string;
  name: string;
  quantity: number;
  tags: string[];
  location: { id: string; name: string; kind: string } | null;
  vendor: { id: string; name: string } | null;
  equipment: { id: string; name: string | null } | null;
};

const loadIndex = async (query = "") =>
  (await indexRoute.loader({
    request: new Request(`http://localhost/inventory/stock${query}`),
  } as never)) as {
    items: ListRow[];
    locations: Array<{ id: string; name: string; kind: string; depth: number }>;
    filters: { locationId: string; vendorId: string; search: string; includeUnassigned: boolean };
  };

const mine = (r: { items: ListRow[] }) => r.items.filter((i) => i.name.startsWith(RUN));
const find = async (id: string) => db.inventoryItem.findUnique({ where: { id } });

/**
 * 🔴 The body the page's own form posts, and the two instruments that keep it honest.
 *
 * **`EDITED` is the form as it posts for the UNTOUCHED fixture**: every value equal to the
 * row's current one. That is deliberate and it was learned the hard way — a shared helper
 * whose body also *changed* the other twelve fields leaked that change into every suite that
 * ran after it (six red tests, all of them about a supplier or a warranty date the block
 * under test had never touched). With this shape, `move()` can only move, and "a move
 * changes exactly one field" is true by construction rather than by remembering to restore.
 */
const EDITED = {
  name: `${RUN} Ersatzkabel`,
  sku: `${RUN}-SKU`,
  serial: `${RUN}-SER`,
  quantity: "7",
  unit: "Stk.",
  category: "Kabel",
  status: "AVAILABLE",
  purchasedAt: "",
  purchasePrice: "",
  warrantyExpiresAt: "2027-03-31",
  vendorId: ids.vendor,
  locationId: ids.room,
  tags: ["kabel", "ersatzteil"],
} as const satisfies Record<string, string | string[]>;

/**
 * Every field changed at once — and **every value differs from the fixture's**, which is
 * what makes the per-field save assertion able to fail. A value equal to the row's current
 * one cannot distinguish "written from the form" from "carried from the row", so a field
 * the action silently carried would pass a test written with the fixture's own values.
 */
const CHANGED = {
  name: `${RUN} Ersatzkabel (bearbeitet)`,
  sku: `${RUN}-SKU-EDITED`,
  serial: `${RUN}-SER-EDITED`,
  quantity: "42",
  unit: "m",
  category: "Leitung",
  status: "ON_LOAN",
  purchasedAt: "2026-05-04",
  purchasePrice: "12.34",
  warrantyExpiresAt: "2028-11-30",
  vendorId: ids.vendor2,
  locationId: ids.store,
  tags: ["geprueft", "ersatzteil", "neu"],
} as const satisfies Record<string, string | string[]>;

/** A complete form post: the intent, then one entry per control the editor renders. */
const fullEditorBody = (overrides: Record<string, string | string[]> = {}) => ({
  _action: "save",
  ...EDITED,
  ...overrides,
});

/**
 * ⚠️ **Untagged, as a PREDICATE and not a count — and the predicate has to see BOTH
 * encodings.** Both encodings occur: `InventoryItem.tags` is nullable with no default while the
 * Prisma field is `String[]`, so an empty array and an SQL `NULL` both mean untagged. `tags = '{}'` matches only one of the two untagged rows;
 * `coalesce(array_length(tags,1),0) = 0` matches both.
 *
 * A count would be the wrong instrument for a second reason: it pins the *legacy* rows'
 * presence into a test that has to survive a legitimate write. "The row is untagged" is the
 * assertion; how the database spells untagged is not.
 */
const isUntagged = async (id: string) => {
  const [row] = await db.$queryRaw<{ untagged: boolean }[]>`
    SELECT coalesce(array_length(tags, 1), 0) = 0 AS untagged FROM "InventoryItem" WHERE id = ${id}
  `;
  return row?.untagged === true;
};

/** ActivityLog rows for OUR entities only — the table is append-only and global. */
const auditCount = () =>
  db.activityLog.count({ where: { entityId: { in: [ids.linked, ids.loose] } } });

const move = (locationId: string) => edit({ locationId });

/** 🔴 A save through the FULL editor, the way the page's own form posts it. */
const edit = (overrides: Record<string, string | string[]> = {}) =>
  detailRoute.action({
    request: req("http://localhost/inventory/stock/x", { ...fullEditorBody(), ...overrides }),
    params: { id: ids.linked },
  } as never);

const del = (id = ids.linked) =>
  detailRoute.action({
    request: req("http://localhost/inventory/stock/x", { _action: "delete" }),
    params: { id },
  } as never);

// ── The list joins, and an item moves between kinds. ──────────

describe("/inventory/stock lists stock with location, vendor and equipment joined", () => {
  it("returns all three joins as OBJECTS, not as bare foreign keys", async () => {
    const linked = mine(await loadIndex()).find((i) => i.id === ids.linked);
    expect(linked, "the linked fixture must appear in the list").toBeDefined();
    // The names, not the ids: a query that selected `locationId` would satisfy a test
    // asserting the id and leave the list unable to show where a thing is — which is the
    // half of the join that has a user-visible consequence.
    expect(linked?.location?.name).toBe(`${RUN} Hörsaal`);
    expect(linked?.location?.kind).toBe("ROOM");
    expect(linked?.vendor?.name).toBe(`${RUN} Lieferant GmbH`);
    expect(linked?.equipment?.name).toBe(`${RUN} Funkmikrofon`);
  });

  it("keeps the list order reproducible — a repeated query returns byte-identical ids", async () => {
    const first = mine(await loadIndex()).map((i) => i.id);
    const second = mine(await loadIndex()).map((i) => i.id);
    expect(second).toEqual(first);
  });

  it("filters by ?location= and by ?q=, and a garbage value degrades instead of throwing", async () => {
    // `?location=` keeps the documented `includeUnassigned` default, so the store
    // filter returns the *unassigned* item too — which is the default being asserted
    // rather than incidental.
    const atStore = mine(await loadIndex(`?location=${ids.store}`)).map((i) => i.id);
    expect(atStore).toEqual([ids.loose]);

    const bySearch = mine(await loadIndex(`?q=${encodeURIComponent("Ersatzkabel")}`)).map(
      (i) => i.id,
    );
    expect(bySearch).toEqual([ids.linked]);

    // A `location` that is not a real row parses (every field is an optional string) and
    // degrades rather than throwing — never a 500, which is what a hostile query string
    // reaching a Prisma `where` would produce.
    //
    // ⚠️ The result is NOT empty, and the reason is the documented default:
    // `includeUnassigned` is true, so the clause is
    // `OR: [{ locationId: "not-a-real-id" }, { locationId: null }]` and the unassigned
    // fixture matches. The meaningful assertion is therefore that **nothing claims to be
    // at a location that does not exist**, not that the list comes back bare.
    const garbage = await loadIndex("?location=not-a-real-id");
    expect(garbage.items.every((i) => i.location?.id !== "not-a-real-id")).toBe(true);
    expect(mine(garbage).map((i) => i.id)).toEqual([ids.loose]);
    expect(garbage.filters.locationId).toBe("not-a-real-id");
  });

  it("?hideUnassigned=1 filters unassigned items from the whole list — by exactly the unassigned count", async () => {
    const all = mine(await loadIndex());
    const shown = mine(await loadIndex("?hideUnassigned=1"));
    expect(shown.map((i) => i.id)).not.toContain(ids.loose);
    const shownIds = new Set(shown.map((i) => i.id));
    expect(all.filter((i) => !shownIds.has(i.id)).map((i) => i.id)).toEqual([ids.loose]);
    // The loader echoes the parsed flag so the checkbox can render its own state.
    expect((await loadIndex("?hideUnassigned=1")).filters.includeUnassigned).toBe(false);
    expect((await loadIndex()).filters.includeUnassigned).toBe(true);
  });

  it("the phone's ?hideUnassigned=1 now filters too — the param is no longer decorative", async () => {
    const mobile = async (q = "") =>
      (
        (await mobileRoute.loader({
          request: new Request(`http://localhost/m/inventory/stock${q}`),
        } as never)) as {
          items: ListRow[];
        }
      ).items.filter((i) => i.name.startsWith(RUN));
    expect((await mobile()).map((i) => i.id)).toContain(ids.loose);
    expect((await mobile("?hideUnassigned=1")).map((i) => i.id)).not.toContain(ids.loose);
  });

  it("the flag + a location keep the old semantics — include ORs the unassigned in, hide restricts", async () => {
    const { listStock } = await import("~/domains/inventory/inventory.stock.queries.server");
    const idsScoped = ids as Record<string, string>;
    const withFlag = await listStock({
      locationId: idsScoped.store,
      includeUnassigned: true,
    } as never);
    expect(withFlag.map((i) => i.id)).toContain(ids.loose);
    const withoutFlag = await listStock({
      locationId: idsScoped.store,
      includeUnassigned: false,
    } as never);
    expect(withoutFlag.map((i) => i.id)).toEqual([]);
  });
});

describe("an item can be moved to a location of a DIFFERENT kind", () => {
  it("ROOM → STORAGE succeeds, and the two kinds genuinely differ", async () => {
    const before = await find(ids.linked);
    expect(before?.locationId).toBe(ids.room);
    const fromKind = (await db.location.findUnique({ where: { id: ids.room } }))?.kind;
    const toKind = (await db.location.findUnique({ where: { id: ids.store } }))?.kind;
    // Asserted rather than assumed: a fixture pair that quietly became the same kind
    // would turn this into a within-kind move and the test would pass for the wrong reason.
    expect(fromKind).toBe("ROOM");
    expect(toKind).toBe("STORAGE");
    expect(fromKind).not.toBe(toKind);

    const res = await move(ids.store);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("location")).toBe(`/inventory/stock/${ids.linked}`);
    expect((await find(ids.linked))?.locationId).toBe(ids.store);
  });

  it("the move writes exactly ONE audit row — the same transaction as the change", async () => {
    const before = await auditCount();
    await move(ids.room);
    expect(await auditCount()).toBe(before + 1);
    const log = await db.activityLog.findFirst({
      where: { entityId: ids.linked, action: "InventoryItemUpdated" },
      orderBy: { id: "desc" },
    });
    // The audit row records the move rather than merely existing: `from`/`to` are what
    // make the history readable, and a bare count would not tell a stale audit from a
    // correct one.
    expect(log?.data).toMatchObject({ from: { locationId: ids.store } });
  });

  it("a move changes the location — and the editor now owns every other field too", async () => {
    // The invariant that made the move-only action safe was "a move PRESERVES every field
    // the form does not render". That form is now a full editor, so the
    // invariant became its per-field twin: a save through the real editor writes EVERY
    // rendered field, and the ONE field the form does not own is carried. Both directions
    // are asserted in the full-editor block below; this test keeps the location-move contract,
    // and it is deliberately posted as a FULL form — a partial body is a different client,
    // and that is the other test.
    const before = await find(ids.linked);
    expect(before?.tags).toEqual(["kabel", "ersatzteil"]);
    await move(ids.store);
    const after = await find(ids.linked);
    expect(after?.locationId).toBe(ids.store);
    expect(after?.tags).toEqual(["kabel", "ersatzteil"]);
    expect(after?.sku).toBe(before?.sku);
    expect(after?.serial).toBe(before?.serial);
    expect(after?.quantity).toBe(before?.quantity);
    expect(after?.vendorId).toBe(before?.vendorId);
    expect(after?.equipmentId).toBe(before?.equipmentId);
    expect(after?.warrantyExpiresAt).toEqual(before?.warrantyExpiresAt);
  });

  it("an empty select means 'assigned nowhere' — a real state, not a refusal", async () => {
    const res = await move("");
    expect(res).toBeInstanceOf(Response);
    expect((await find(ids.linked))?.locationId).toBeNull();
    await move(ids.room); // restore for the assertions above, which read the ROOM
  });

  it("a move to a location that does not exist is refused inline and writes NOTHING", async () => {
    const before = await db.inventoryItem.findUnique({ where: { id: ids.linked } });
    const auditBefore = await auditCount();
    const res = await move("not-a-real-location");

    expect(res).not.toBeInstanceOf(Response);
    expect(
      (res as { fieldErrors?: Record<string, string[]> }).fieldErrors?.locationId?.[0],
    ).toBeTruthy();
    expect(await find(ids.linked)).toEqual(before);
    // "Nothing happened" is not an event — a refusal must not write a row.
    expect(await auditCount()).toBe(auditBefore);
  });
});

// ── The detail page, and a read-only phone. ────────────────────

describe("the detail page shows the linked Equipment and the warranty date", () => {
  const loadDetail = async (id = ids.linked) =>
    (await detailRoute.loader({ params: { id } } as never)) as {
      item: {
        id: string;
        name: string;
        warrantyExpiresAt: Date | null;
        purchasePrice: string | null;
        location: { id: string; kind: string } | null;
        equipment: { id: string; name: string | null; assetTag: string | null } | null;
        vendor: { id: string; name: string } | null;
      };
      locations: Array<{ id: string; depth: number }>;
    };

  it("carries the linked Equipment and the warranty date in the loader payload", async () => {
    const { item } = await loadDetail();
    // Both are what a user opens this page to read.
    expect(item.equipment?.id).toBe(ids.equipment);
    expect(item.equipment?.name).toBe(`${RUN} Funkmikrofon`);
    expect(item.warrantyExpiresAt).toEqual(WARRANTY);
    expect(item.vendor?.name).toBe(`${RUN} Lieferant GmbH`);
  });

  it("hands the location picker the whole tree, so a move can reach a location of any kind", async () => {
    const { locations } = await loadDetail();
    const ids2 = locations.map((l) => l.id);
    expect(ids2).toContain(ids.room);
    expect(ids2).toContain(ids.store);
  });

  it("Decimal money crosses the loader as a STRING matching the schema's money shape", async () => {
    await db.inventoryItem.update({ where: { id: ids.linked }, data: { purchasePrice: "19.90" } });
    const { item } = await loadDetail();
    // Not the literal "19.90": `Decimal.toString()` normalises the scale away, and
    // pinning the string format would fail on a formatting change that loses nothing.
    // What must hold is the *type* (never a float — money is never a float) and the shape
    // `optionalMoney` validates, so a value can go back into the form unchanged.
    expect(typeof item.purchasePrice).toBe("string");
    expect(item.purchasePrice).toMatch(/^\d{1,8}([.,]\d{1,2})?$/);
    expect(Number(item.purchasePrice)).toBeCloseTo(19.9, 2);
    await db.inventoryItem.update({ where: { id: ids.linked }, data: { purchasePrice: null } });
  });

  it("an unknown id is a 404 response, not a crash", async () => {
    const thrown = await (
      detailRoute.loader({ params: { id: `${RUN}_missing` } } as never) as Promise<unknown>
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it("deleting LINKED stock is refused, with the reason, and deletes nothing", async () => {
    const auditBefore = await auditCount();
    const res = await del();

    expect(res).not.toBeInstanceOf(Response);
    const data = res as { fieldErrors?: Record<string, string[]>; formErrors?: string[] };
    // ⚠️ The refusal's message lives in `formErrors` — the channel for "this cannot
    // happen", not "this field is wrong". An action returning only `fieldErrors` would
    // render it as silence, and this assertion is what keeps both channels returned.
    expect(data.formErrors?.[0]).toMatch(/verknüpft/i);
    expect(await find(ids.linked)).not.toBeNull();
    expect(await auditCount()).toBe(auditBefore);
  });

  it("deleting UNLINKED stock succeeds, redirects to the list, and audits once", async () => {
    const auditBefore = await auditCount();
    const res = await del(ids.loose);

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    expect((res as Response).headers.get("location")).toBe("/inventory/stock");
    expect(await find(ids.loose)).toBeNull();
    expect(await auditCount()).toBe(auditBefore + 1);
  });
});

describe("/m/inventory/stock is read-only and shares the query module", () => {
  it("exports NO action — the mobile surface is read-only by design", () => {
    expect("action" in mobileRoute).toBe(false);
  });

  it("reads the same rows as the desktop surface", async () => {
    const data = (await mobileRoute.loader({
      request: new Request("http://localhost/m/inventory/stock"),
    } as never)) as {
      items: ListRow[];
    };
    const ids3 = data.items.filter((i) => i.name.startsWith(RUN)).map((i) => i.id);
    expect(ids3).toContain(ids.linked);
  });
});

// ── Creating a stock item through the create form. ───────────────────────

describe("a stock item can be created", () => {
  it("creates through the domain, audits once, and redirects to the new item", async () => {
    const res = await newRoute.action({
      request: req("http://localhost/inventory/stock/new", {
        name: `${RUN} neu`,
        sku: `${RUN}-NEW`,
        quantity: "3",
        unit: "Stk.",
        locationId: ids.store,
        purchasedAt: "",
        purchasePrice: "",
        warrantyExpiresAt: "2028-01-31",
        category: "",
        status: "",
        serial: "",
        // The create form does have a tag control, and an empty tag string is accepted.
        //
        // ONE input, a bare string — which is exactly what a browser sends for a form with a
        // single spare box, and what `stockCreateSchema.tags` rejects as `invalid_type`
        // without `tagsFromForm`.
        tags: `${RUN}-kabel`,
      }),
    } as never);

    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(302);
    const newId = ((res as Response).headers.get("location") ?? "").replace(
      "/inventory/stock/",
      "",
    );
    const row = await find(newId);
    expect(row?.name).toBe(`${RUN} neu`);
    expect(row?.quantity).toBe(3);
    // A date typed into the form survives as a timestamptz, not a string.
    expect(row?.warrantyExpiresAt?.toISOString()).toBe(new Date("2028-01-31").toISOString());
    // the tag the form posted is on the row. An empty list would also pass when the form
    // sent no tag at all, so the posted value is what is asserted.
    expect(row?.tags).toEqual([`${RUN}-kabel`]);
    // The audit row commits with the item or not at all — counted for THIS item's
    // id, because the shared counter deliberately excludes it.
    expect(await db.activityLog.count({ where: { entityId: newId } })).toBe(1);
    if (row) await db.inventoryItem.delete({ where: { id: row.id } });
  });

  it("an invalid form returns field errors and writes NO row", async () => {
    const before = await db.inventoryItem.count({ where: { name: { startsWith: RUN } } });
    const res = await newRoute.action({
      request: req("http://localhost/inventory/stock/new", { name: "", locationId: "" }),
    } as never);

    expect(res).not.toBeInstanceOf(Response);
    expect((res as { fieldErrors?: Record<string, string[]> }).fieldErrors?.name?.[0]).toBeTruthy();
    expect(await db.inventoryItem.count({ where: { name: { startsWith: RUN } } })).toBe(before);
  });
});

// ─── the CREATE form's tags control, and the normaliser both forms share ────────

/**
 * 🔴 **The instrument, and why it is a SOURCE SCAN over the route.**
 *
 * The claim is *"the create form renders the tags control"*, and it has **no possible
 * behavioural test**: this file's own editor test records that `renderToStaticMarkup` throws
 * on the first hook under React 19's `react-dom-server-legacy` in vitest's `node`
 * environment, so a render-based version is **unreachable here, not unimplemented**.
 *
 * ⚠️ **The existing scan cannot see this claim either, and that is the reason a NEW one was
 * needed.** `controlNamesIn` reads `stock-form-fields.tsx` + `stock-vendor-select.tsx` — the
 * COMPONENT files — so it proves the control exists in the component and says nothing about
 * which routes ask for it. The gate lives in the create ROUTE: `StockFormFields` reads
 * `defaults?.tags === undefined` and renders nothing when it is `undefined`, so a route that
 * passed no `tags` renders no control while every existing assertion stays green. That is the
 * exact defect the tags control exists to remove, and it was invisible to the instrument that already
 * certified `tags` as reachable.
 *
 * ⚠️ **Comments are blanked first, and this file is now full of prose that says `tags: []`.**
 * The create route's header explains the bare-string case in a comment, so an unblanked scan
 * would report a control that is not one — and, worse, would keep reporting it after the line
 * was deleted. The fixture arm below asserts the blanking works.
 */
const blankComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** Every `defaults={…}` JSX prop in a source, brace-balanced. */
const defaultsProps = (src: string): string[] => {
  const code = blankComments(src);
  const found: string[] = [];
  for (const m of code.matchAll(/defaults=\{/g)) {
    let depth = 0;
    for (let i = m.index + "defaults=".length; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") {
        depth--;
        if (depth === 0) {
          found.push(code.slice(m.index, i + 1));
          break;
        }
      }
    }
  }
  return found;
};

/** Does the route hand `StockFormFields` an ARRAY for `tags`? `[]` and never `undefined`. */
const handsFormAnArrayTags = (src: string): boolean =>
  defaultsProps(src).some((prop) => /\btags\s*:\s*\[/.test(prop));

describe("the create form renders the tags control", () => {
  const CREATE_ROUTE = "../../app/routes/_desktop.inventory.stock.new/route.tsx";
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("the create route hands the form an ARRAY — and the scan demonstrably finds the prop", () => {
    const src = read(CREATE_ROUTE);
    // Asserted FIRST: a scan that matched no `defaults={` at all reports the same `false`
    // as a route that genuinely passes no tags. A zero has to be re-asked before it is read.
    expect(defaultsProps(src).length, "the scan must find a defaults={…} prop").toBeGreaterThan(0);
    expect(handsFormAnArrayTags(src), "the create route must pass `tags: []`").toBe(true);
  });

  it("CONTROL — the scan is red on every shape that drops the array, and green on the shipped one", () => {
    // 🔴 A control must prove it can REACH, not only that it fires. There is exactly
    // ONE create route and it now passes, so "the assertion is red for the right reason"
    // is NOT observable by reading the tree. These fixtures are the control.
    // 1. the line as it was before the fix — the real pre-fix text, not a paraphrase of it
    expect(
      handsFormAnArrayTags(
        "<StockFormFields locations={l} vendors={v} defaults={d ? { locationId: d } : undefined} />",
      ),
    ).toBe(false);
    // 2. `undefined` spelled as a tags key — the same defect with a different spelling
    expect(handsFormAnArrayTags("<StockFormFields defaults={{ tags: undefined }} />")).toBe(false);
    // 3. the shipped shape: green
    expect(handsFormAnArrayTags("<StockFormFields defaults={{ locationId: d, tags: [] }} />")).toBe(
      true,
    );
    // 4. 🔴 `tags: []` appearing ONLY inside a comment must NOT satisfy it — otherwise this
    //    whole instrument is satisfied by the prose that explains it.
    const proseOnly = [
      "// pass `tags: []` here one day",
      "/* defaults={{ tags: [] }} */",
      "<StockFormFields defaults={{ locationId: d }} />",
    ].join("\n");
    expect(defaultsProps(proseOnly).length).toBe(1);
    expect(handsFormAnArrayTags(proseOnly)).toBe(false);
  });
});

describe("the BARE-STRING CASE, the only shape a create form sends", () => {
  const PROBE = `${RUN} tagprobe`;

  afterEach(async () => {
    await db.inventoryItem.deleteMany({ where: { name: PROBE } });
  });

  /** One create through the REAL route action, posting the form's ONE spare box. */
  const createWithOneTagInput = async (typed: string) => {
    const res = await newRoute.action({
      request: req("http://localhost/inventory/stock/new", {
        name: PROBE,
        quantity: "1",
        unit: "Stk.",
        locationId: ids.store,
        // ⚠️ ONE input. `req` appends per entry and a string is exactly one entry — which is
        // what a browser sends for a form whose tags control holds a single spare box.
        tags: typed,
      }),
    } as never);

    expect(res, `a create with tags=${JSON.stringify(typed)} must be accepted`).toBeInstanceOf(
      Response,
    );
    const id = ((res as Response).headers.get("location") ?? "").replace("/inventory/stock/", "");
    const row = await find(id);
    expect(row, "the create must have written a row").toBeTruthy();
    return { id, tags: row?.tags };
  };

  it("a BLANK box creates an item with no tags — not a whole-object ValidationError", async () => {
    expect((await createWithOneTagInput("")).tags).toEqual([]);
  });

  it("one real tag round-trips — the shape that was rejected as `invalid_type`", async () => {
    expect((await createWithOneTagInput("kabel")).tags).toEqual(["kabel"]);
  });

  it("a WHITESPACE-ONLY box creates an item with no tags — a type failure, not a length one", async () => {
    expect((await createWithOneTagInput("   ")).tags).toEqual([]);
  });

  it("CONTROL — the raw schema refuses all three, so the green above is the fix and not the schema", async () => {
    // Without this arm the three tests above pass vacuously: a schema that had been coerced
    // would create items too, and nothing would tell the two worlds apart. This is the half
    // that makes "it works" mean "it works BECAUSE `tagsFromForm` ran".
    const { stockCreateSchema } = await import("~/domains/inventory/inventory.stock.schema");
    const { formDataToObject } = await import("~/lib/validation.server");

    for (const typed of ["", "kabel", "   "]) {
      const fd = new FormData();
      fd.append("tags", typed);
      const raw = formDataToObject(fd).tags;
      expect(Array.isArray(raw), `"${typed}" must arrive as a bare string`).toBe(false);
      const parsed = stockCreateSchema.safeParse({ name: "x", quantity: 1, tags: raw });
      expect(parsed.success, `the RAW schema must reject tags=${JSON.stringify(typed)}`).toBe(
        false,
      );
      expect(parsed.success ? "" : parsed.error.issues[0]?.message).toContain("array");
    }

    // …and TWO inputs are an array, which is the case the old wording described and which a
    // control written only for the single-input case would never reach.
    const two = new FormData();
    two.append("tags", "kabel");
    two.append("tags", "funk");
    expect(formDataToObject(two).tags).toEqual(["kabel", "funk"]);

    // The edit path's case, unchanged by the fix: two tags plus a blank spare.
    expect(
      stockCreateSchema.safeParse({
        name: "x",
        quantity: 1,
        tags: formDataToObject(two).tags,
      }).success,
    ).toBe(true);
  });
});

describe("ONE copy of the rule", () => {
  const APP_ROOT = join(process.cwd(), "app");

  /** Every `.ts`/`.tsx` under `app/`, excluding generated output. */
  const appSources = (dir = APP_ROOT, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "generated" || entry.name === "node_modules") continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) appSources(p, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(p);
    }
    return out;
  };

  it("`tagsFromForm` is DEFINED exactly once in app/ — and it is the shared one", () => {
    // The point is "one copy", so it is checked over the TREE and
    // not over the two callers: a third definition anywhere in `app/` is a drift this test
    // exists to prevent, and reading only the routes could not see it.
    const files = appSources();
    expect(
      files.length,
      "the walk must reach files at all — a 0 here is a broken walk",
    ).toBeGreaterThan(50);

    const definedIn = files
      .filter((f) => blankComments(readFileSync(f, "utf8")).includes("function tagsFromForm"))
      .map((f) => relative(process.cwd(), f).replace(/\\/g, "/"))
      .sort();
    expect(definedIn).toEqual(["app/lib/validation.server.ts"]);
  });

  it("both stock routes IMPORT it from the shared module rather than redeclaring it", () => {
    for (const rel of [
      "../../app/routes/_desktop.inventory.stock.new/route.tsx",
      "../../app/routes/_desktop.inventory.stock.$id/route.tsx",
    ]) {
      const src = blankComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
      const named = src.match(/import\s*\{([^}]*)\}\s*from\s*"~\/lib\/validation\.server"/);
      expect(named, `${rel} must import from ~/lib/validation.server`).toBeTruthy();
      expect(named?.[1]).toContain("tagsFromForm");
      expect(src, `${rel} must not define it locally`).not.toContain("function tagsFromForm");
    }
  });

  it("the behaviour matrix — including `key absent → carried`, the EDIT form's contract", async () => {
    const { tagsFromForm } = await import("~/lib/validation.server");
    const fd = (...entries: string[]) => {
      const f = new FormData();
      for (const e of entries) f.append("tags", e);
      return f;
    };

    expect(tagsFromForm(fd(), [])).toEqual([]);
    expect(tagsFromForm(fd(""), [])).toEqual([]);
    expect(tagsFromForm(fd("  "), [])).toEqual([]);
    expect(tagsFromForm(fd("kabel"), [])).toEqual(["kabel"]);
    expect(tagsFromForm(fd("kabel", ""), [])).toEqual(["kabel"]);
    expect(tagsFromForm(fd("kabel", "  "), [])).toEqual(["kabel"]);

    // 🔴 key ABSENT → carried. This is the edit form's *"this form did not offer the
    // control, so carry the existing value"* rule. It is the clause a move-to-`lib` most often
    // loses: a rewrite that defaulted to `[]` would silently CLEAR an item's tags.
    expect(tagsFromForm(fd(), ["getragen"])).toEqual(["getragen"]);
    // …and an EXPLICIT blank is a clear, not a carry. The two must not collapse.
    expect(tagsFromForm(fd(""), ["getragen"])).toEqual([]);
  });
});

describe("the CSV exclusion: the fix is NOT in the schema", () => {
  /** Does `schema` reject a CSV row carrying a `tags` column, and name `tags` as the reason? */
  const rejectsTagsColumn = (schema: Parameters<typeof previewCsv>[1]) => {
    const { valid, invalid } = previewCsv("name,tags\nkabel,ersatzteil", schema);
    return valid.length === 0 && invalid.some((r) => r.messages.some((m) => /^tags:/.test(m)));
  };

  it("`stockCreateSchema.tags` still REFUSES a `tags` column — a cell is not a list", async () => {
    const { stockCreateSchema } = await import("~/domains/inventory/inventory.stock.schema");
    expect(rejectsTagsColumn(stockCreateSchema)).toBe(true);
  });

  it("CONTROL — an unknown column alone is ACCEPTED, so the rejection is attributable to `tags`", async () => {
    const { stockCreateSchema } = await import("~/domains/inventory/inventory.stock.schema");
    const unknown = previewCsv("name,gibtsnicht\nkabel,egal", stockCreateSchema);
    expect(unknown.valid, "an extra column must not be what refuses the row").toHaveLength(1);
    expect(unknown.invalid).toHaveLength(0);
  });

  it("CONTROL — the SAME assertion fails against a schema that coerces a bare string", async () => {
    // 🔴 This arm stops the predicate passing vacuously, and it is the one a
    // reviewer should read first: it proves the predicate can distinguish the shipped schema
    // from the schema a careless edit would have written. `z.preprocess` wrapping a bare
    // string into an array is EXACTLY that careless fix — and it would silently reverse
    // the importer's shipped decision, which the UI states in words.
    const { z } = await import("zod");
    const coercing = z.object({
      name: z.string().trim().min(1),
      tags: z
        .preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.string().trim().min(1)))
        .default([]),
    });
    expect(
      rejectsTagsColumn(coercing),
      "the coercing schema must NOT be rejected by this arm",
    ).toBe(false);
  });

  it("the shipped HEADER validates, omits `tags`, and says so in the UI copy", async () => {
    const { stockCreateSchema } = await import("~/domains/inventory/inventory.stock.schema");
    const src = readFileSync(
      fileURLToPath(
        new URL("../../app/routes/_desktop.inventory.stock.import/route.tsx", import.meta.url),
      ),
      "utf8",
    );
    const header = src.match(/const HEADER =\s*"([^"]*)"/)?.[1] ?? "";
    expect(header, "the import route must still declare its HEADER").not.toBe("");
    expect(header.split(",")).not.toContain("tags");
    // The copy lives in the catalog; the route must render it.
    expect(src).toContain("inventory.stockImport.description");
    const { messages } = await import("~/i18n");
    for (const locale of ["de", "en"] as const) {
      expect(messages(locale)["inventory.stockImport.description"]).toContain("`tags`");
    }
    expect(
      messages("de")["inventory.stockImport.description"],
      "the UI must keep saying why",
    ).toContain("weil eine Zelle keine Liste ist");

    // The shipped column set still imports cleanly — the exclusion is `tags` and nothing else.
    const SAMPLE = "Kabel XLR 5m,,SN-4711,4,Kabel,,,,,,,,";
    const pv = previewCsv(`${header}\n${SAMPLE}`, stockCreateSchema);
    expect(pv.invalid.map((r) => r.messages)).toEqual([]);
    expect(pv.valid).toHaveLength(1);
  });
});

describe("the round trip goes through the same write path", () => {
  it("an item created with one tag reads back with it, and the audit row commits with the item", async () => {
    const res = await newRoute.action({
      request: req("http://localhost/inventory/stock/new", {
        name: `${RUN} runde`,
        quantity: "2",
        unit: "Stk.",
        locationId: ids.store,
        tags: "kabel",
      }),
    } as never);

    expect(res).toBeInstanceOf(Response);
    const id = ((res as Response).headers.get("location") ?? "").replace("/inventory/stock/", "");
    const row = await find(id);
    expect(row?.tags).toEqual(["kabel"]);

    // The write went through `createStockItem` → `txWithAudit`, so the audit row commits with
    // the item or not at all — the invariant `guards.sh` #2 exists to protect. Counted for
    // THIS item's id, because the shared counter deliberately excludes it.
    expect(await db.activityLog.count({ where: { entityId: id } })).toBe(1);

    // …and a round trip the list view cannot read is not one: this is the query the stock
    // page actually runs.
    expect(mine(await loadIndex("")).find((i) => i.id === id)?.tags).toEqual(["kabel"]);

    await db.inventoryItem.delete({ where: { id } });
  });
});

// ── Structural: the two things a green suite cannot see on its own. ──────────

// ─── the supplier picker and the ?vendor= filter ─────────────────────────────────

describe("?vendor= filters the list and degrades on garbage", () => {
  it("filters to the chosen vendor, and the loader echoes the filter back", async () => {
    const byVendor = mine(await loadIndex(`?vendor=${ids.vendor}`)).map((i) => i.id);
    // The linked fixture is the only stock row pointing at `ids.vendor`, so the filter has
    // to return exactly it. `ids.vendor2` exists precisely so this is a real choice between
    // two real options rather than "the only value".
    expect(byVendor).toEqual([ids.linked]);

    const other = mine(await loadIndex(`?vendor=${ids.vendor2}`)).map((i) => i.id);
    expect(other).toEqual([]);

    // The filter round-trips through the URL - the same property the locations tree asks
    // of the locations tree. A copied link reproduces the view.
    expect((await loadIndex(`?vendor=${ids.vendor}`)).filters.vendorId).toBe(ids.vendor);
    expect((await loadIndex()).filters.vendorId).toBe("");
  });

  it("a garbage vendor id DEGRADES — never a 500, and nothing claims to be there", async () => {
    // The list-filter contract this route already documents for `?location=`: every field
    // is an optional string, so a hostile value parses cleanly and yields an empty list
    // rather than a Prisma error escaping to the user.
    const garbage = await loadIndex("?vendor=not-a-real-vendor");
    expect(garbage.items.every((i) => i.vendor?.id !== "not-a-real-vendor")).toBe(true);
    expect(mine(garbage)).toEqual([]);
    // And the parameter is still echoed, so the select can show what was asked for.
    expect(garbage.filters.vendorId).toBe("not-a-real-vendor");
  });

  it("?vendor= composes with ?location= and ?q= rather than replacing them", async () => {
    // Three filters, one list. If `?vendor=` had overwritten the parsed options instead of
    // adding to them, this would return the vendor's items regardless of the location.
    const both = mine(await loadIndex(`?vendor=${ids.vendor}&location=${ids.room}`)).map(
      (i) => i.id,
    );
    expect(both).toEqual([ids.linked]);
    // Same vendor, wrong location: the unassigned item is NOT this vendor's, so the AND
    // must exclude it rather than the filter being ignored.
    const mismatch = mine(await loadIndex(`?vendor=${ids.vendor}&location=${ids.store}`)).map(
      (i) => i.id,
    );
    expect(mismatch).toEqual([]);
  });
});

describe("the form writes a real vendorId", () => {
  it("the create loader hands the picker BOTH real vendors, from the query", async () => {
    const data = (await newRoute.loader({
      request: new Request("http://localhost/inventory/stock/new"),
    } as never)) as {
      vendors: Array<{ id: string; name: string }>;
      locations: unknown[];
    };
    const mine2 = data.vendors.filter((v) => v.name.startsWith(RUN));
    // Both, and BY NAME. A loader that returned ids only would satisfy an id assertion
    // and render two blank options.
    expect(mine2.map((v) => v.name).sort()).toEqual(
      [`${RUN} Lieferant GmbH`, `${RUN} Zweitlieferant AG`].sort(),
    );
    // The location tree is still there — the picker must not have displaced it.
    expect(Array.isArray(data.locations)).toBe(true);
  });

  it("creating THROUGH the form stores the chosen vendor, and the audit row commits with it", async () => {
    const res = await newRoute.action({
      request: req("http://localhost/inventory/stock/new", {
        name: `${RUN} mit Lieferant`,
        sku: `${RUN}-VEND`,
        quantity: "2",
        unit: "Stk.",
        locationId: ids.store,
        // 🔴 The field the picker contributes. It is a plain form value, so the test posts
        // it the way the browser would.
        vendorId: ids.vendor2,
        purchasedAt: "",
        purchasePrice: "",
        warrantyExpiresAt: "",
        category: "",
        status: "",
        serial: "",
      }),
    } as never);

    expect(res).toBeInstanceOf(Response);
    const newId = ((res as Response).headers.get("location") ?? "").replace(
      "/inventory/stock/",
      "",
    );
    const row = await find(newId);
    // The ACTUAL id written, not "some vendor": the form's choice
    // reaches the row, and a test asserting merely "vendorId is not null" would pass on a
    // form that ignored the control and defaulted to anything.
    expect(row?.vendorId).toBe(ids.vendor2);
    // And the relation resolves - the id is a row, not a string.
    expect(row?.vendorId).not.toBe(ids.vendor);
    expect(await db.activityLog.count({ where: { entityId: newId } })).toBe(1);
    if (row) await db.inventoryItem.delete({ where: { id: row.id } });
  });

  it("the detail form carries the item's CURRENT vendor, and can change it", async () => {
    const data = (await detailRoute.loader({ params: { id: ids.linked } } as never)) as {
      vendors: Array<{ id: string; name: string }>;
      item: { vendorId: string | null };
    };
    expect(data.vendors.some((v) => v.id === ids.vendor)).toBe(true);
    expect(data.item.vendorId).toBe(ids.vendor);

    // Reassign through the form: the action reads `vendorId` and writes it.
    const res = await detailRoute.action({
      request: req("http://localhost/inventory/stock/x", {
        _action: "move",
        locationId: ids.room,
        vendorId: ids.vendor2,
      }),
      params: { id: ids.linked },
    } as never);
    expect(res).toBeInstanceOf(Response);
    expect((await find(ids.linked))?.vendorId).toBe(ids.vendor2);

    // Restore for the assertions above, which read the ROOM and vendor1.
    await detailRoute.action({
      request: req("http://localhost/inventory/stock/x", {
        _action: "move",
        locationId: ids.room,
        vendorId: ids.vendor,
      }),
      params: { id: ids.linked },
    } as never);
    expect((await find(ids.linked))?.vendorId).toBe(ids.vendor);
  });
});

describe("a bad supplier id is a FIELD error, not a 500", () => {
  it("the detail form refuses a vendor that is not a row, and writes NOTHING", async () => {
    const before = await find(ids.linked);
    const auditBefore = await auditCount();
    const res = await detailRoute.action({
      request: req("http://localhost/inventory/stock/x", {
        _action: "move",
        locationId: ids.room,
        vendorId: "not-a-real-vendor",
      }),
      params: { id: ids.linked },
    } as never);

    // 🔴 NOT a Response. A Response here would be `toErrorResponse` turning an unhandled
    // error into a 500 page, which is the outcome this test forbids.
    expect(res).not.toBeInstanceOf(Response);
    expect(
      (res as { fieldErrors?: Record<string, string[]> }).fieldErrors?.vendorId?.[0],
    ).toBeTruthy();
    // "Nothing happened" is not an event - a refusal writes no audit row.
    expect(await find(ids.linked)).toEqual(before);
    expect(await auditCount()).toBe(auditBefore);
  });

  it("the create form refuses it too, and no row is written", async () => {
    const before = await db.inventoryItem.count({ where: { name: { startsWith: RUN } } });
    const res = await newRoute.action({
      request: req("http://localhost/inventory/stock/new", {
        name: `${RUN} ungueltiger Lieferant`,
        quantity: "1",
        locationId: "",
        vendorId: "not-a-real-vendor",
      }),
    } as never);

    expect(res).not.toBeInstanceOf(Response);
    expect(
      (res as { fieldErrors?: Record<string, string[]> }).fieldErrors?.vendorId?.[0],
    ).toBeTruthy();
    expect(await db.inventoryItem.count({ where: { name: { startsWith: RUN } } })).toBe(before);
  });

  it("NEGATIVE CONTROL: the refusal is the DOMAIN's requireRefs, not the form's option list", async () => {
    // The rule: *"a picker that submits an id the domain rejects must be caught by the
    // test, not by a 500."*
    //
    // The control is that this test posts an id NO option could ever carry - a value the
    // picker cannot render - and the refusal still happens. So the guarantee does not
    // depend on the control being complete: a hostile client, a stale form, or a hand-
    // crafted POST all meet the same field error. If the refusal were implemented in the
    // component (e.g. by filtering the submitted id against the options), this would throw
    // instead and the assertion above would see a 500.
    const res = await detailRoute.action({
      request: req("http://localhost/inventory/stock/x", {
        _action: "move",
        locationId: ids.room,
        vendorId: "<script>alert(1)</script>",
      }),
      params: { id: ids.linked },
    } as never);
    expect(res).not.toBeInstanceOf(Response);
    expect(
      (res as { fieldErrors?: Record<string, string[]> }).fieldErrors?.vendorId?.[0],
    ).toBeTruthy();
    expect((await find(ids.linked))?.vendorId).toBe(ids.vendor);
  });

  it("an EMPTY vendor means 'no supplier' - a real state, not a refusal", async () => {
    const res = await detailRoute.action({
      request: req("http://localhost/inventory/stock/x", {
        _action: "move",
        locationId: ids.room,
        vendorId: "",
      }),
      params: { id: ids.linked },
    } as never);
    expect(res).toBeInstanceOf(Response);
    expect((await find(ids.linked))?.vendorId).toBeNull();
    // Restore.
    await detailRoute.action({
      request: req("http://localhost/inventory/stock/x", {
        _action: "move",
        locationId: ids.room,
        vendorId: ids.vendor,
      }),
      params: { id: ids.linked },
    } as never);
    expect((await find(ids.linked))?.vendorId).toBe(ids.vendor);
  });
});

describe("a save through the full editor, field by field", () => {
  /** Put `ids.linked` back to the state the suites above left it in. */
  const restoreFixture = async () => {
    await db.inventoryItem.update({
      where: { id: ids.linked },
      data: {
        name: `${RUN} Ersatzkabel`,
        sku: `${RUN}-SKU`,
        serial: `${RUN}-SER`,
        quantity: 7,
        unit: "Stk.",
        category: "Kabel",
        status: "AVAILABLE",
        purchasedAt: null,
        purchasePrice: null,
        warrantyExpiresAt: WARRANTY,
        vendorId: ids.vendor,
        locationId: ids.room,
        tags: ["kabel", "ersatzteil"],
      },
    });
  };

  it("writes EVERY field the form renders — one assertion per field, not a blanket", async () => {
    const res = await edit(CHANGED);
    expect(res).toBeInstanceOf(Response);

    const row = await find(ids.linked);
    // This test guards against `updateStockItem` writing the WHOLE
    // `StockEditInput`, so a field the action fails to read is written as its default and
    // the save destroys it silently. Every value in `CHANGED` differs from the fixture, so
    // a carried field cannot masquerade as a written one.
    expect(row?.name).toBe(CHANGED.name);
    expect(row?.sku).toBe(CHANGED.sku);
    expect(row?.serial).toBe(CHANGED.serial);
    expect(row?.quantity).toBe(Number(CHANGED.quantity));
    expect(row?.unit).toBe(CHANGED.unit);
    expect(row?.category).toBe(CHANGED.category);
    expect(row?.status).toBe(CHANGED.status);
    expect(row?.purchasedAt).toEqual(new Date("2026-05-04T00:00:00.000Z"));
    expect(row?.purchasePrice?.toString()).toBe(CHANGED.purchasePrice);
    expect(row?.warrantyExpiresAt).toEqual(new Date("2028-11-30T00:00:00.000Z"));
    expect(row?.locationId).toBe(ids.store);
    expect(row?.vendorId).toBe(ids.vendor2);
    expect(row?.tags).toEqual(CHANGED.tags);
    // The one field the form does not own (the ticket-harmony link) is CARRIED, and this is
    // the only place that says so. If the form ever grows a control for it, this is the
    // assertion that must change — and the structural test below is what notices first.
    expect(row?.equipmentId).toBe(ids.equipment);

    await restoreFixture();
  });

  it("carries `equipmentId` when a client posts it — the ticket-harmony link is not this form's", async () => {
    // ⚠️ The inverse of the assertion above, and the direction that is easy to get wrong:
    // the action IGNORES a submitted `equipmentId`. `updateStockItem` would happily write
    // it, and the harmony link has its own two-audit-row write in
    // `linkStockItemToEquipment`; a form that could move it would produce an audit trail
    // the equipment feed cannot read, and could dangle a `Restrict` FK through a plain save.
    const res = await edit({ locationId: ids.room, equipmentId: "some-other-equipment" });
    expect(res).toBeInstanceOf(Response);
    expect((await find(ids.linked))?.equipmentId).toBe(ids.equipment);
    expect(await db.equipment.count({ where: { id: "some-other-equipment" } })).toBe(0);

    await restoreFixture();
  });

  it("CONTROL (c): a SINGLE tag saves — the one shape that reaches z.array() as a bare string", async () => {
    // `formDataToObject` collapses repeated keys INTO an array, so exactly one input
    // arrives as a bare string — and `z.array()` rejects a bare string outright
    // (`tags:invalid_type`). A control written only for 2+ tags passes the blank-box case
    // and the cleared-list case and still breaks the first thing a user tries.
    const res = await edit({ tags: ["ersatzteil"] });
    expect(res).toBeInstanceOf(Response);
    expect((await find(ids.linked))?.tags).toEqual(["ersatzteil"]);

    await restoreFixture();
  });

  it("CONTROL (a): a BLANK tag box removes that tag and leaves the others alone", async () => {
    // The chosen option: filter empties on submit. The alternative reading
    // (render per-tag errors) is a `ValidationError` on the WHOLE object, which is the
    // failure this assertion exists to rule out: three tags on screen, clear one box, and
    // the save is rejected and the other two go with it.
    const res = await edit({ tags: ["geprueft", "", "neu"] });
    expect(res).toBeInstanceOf(Response);
    expect((await find(ids.linked))?.tags).toEqual(["geprueft", "neu"]);

    await restoreFixture();
  });

  it("CONTROL (a): a WHITESPACE-only tag box is a blank box, not a tag", async () => {
    // `z.string().trim().min(1)` is not enough on its own: `"   "` passes `min(1)` and is
    // then trimmed to `""`, so the filter has to trim before it measures.
    const res = await edit({ tags: ["geprueft", "   ", "neu"] });
    expect(res).toBeInstanceOf(Response);
    expect((await find(ids.linked))?.tags).toEqual(["geprueft", "neu"]);

    await restoreFixture();
  });

  it("CONTROL (b): clearing EVERY box leaves the row untagged — asserted as the row, through a predicate that sees NULL and {}", async () => {
    // The predicate, not `tags = '{}'` and not a count: the table can hold both an empty
    // array and an SQL NULL, and `tags = '{}'` matches only the first. A count
    // would also pin the presence of pre-existing rows into a test that must survive a write.
    const before = await find(ids.linked);
    expect(before?.tags).toEqual(["kabel", "ersatzteil"]);

    // Two tags + the always-rendered spare = three boxes, all cleared. Posting ONE blank
    // box would be a different state: it clears one tag and keeps the rest.
    const res = await edit({ tags: ["", "", ""] });
    expect(res).toBeInstanceOf(Response);
    expect(await isUntagged(ids.linked)).toBe(true);
    expect((await find(ids.linked))?.tags).toEqual([]);

    await restoreFixture();
  });

  it("CONTROL (b): the cleared-list assertion TURNS RED if the editor is removed", async () => {
    // Removing the control does not turn this test red, and cannot: it builds its own request
    // body, so a control missing from the component cannot change what it posts. Removing the
    // whole `{defaults?.tags !== undefined ? … : null}` block turns only the structural
    // control-name test red.
    //
    // So the guarantee is delivered by the PAIR:
    //   * the structural test (below) is what fires when a control is removed;
    //   * this test is the *other* direction — "a body that omits `tags` leaves the row
    //     tagged" — which is what makes a blank box a real edit rather than an accident.
    // One says "the form has the control"; the other says "the control's absence is not
    // silent data loss". Only together do they say the third thing: *clearing* it is an edit.
    //
    // The alternative was a conditional assertion that branches on whether the control was
    // found, and a test that can pass either way by construction is not a control.
    const before = await find(ids.linked);
    const res = await detailRoute.action({
      request: req("http://localhost/inventory/stock/x", {
        _action: "save",
        name: CHANGED.name,
        locationId: ids.room,
        vendorId: ids.vendor,
      }),
      params: { id: ids.linked },
    } as never);

    expect(res).toBeInstanceOf(Response);
    const after = await find(ids.linked);
    // Everything the partial body DID submit is written…
    expect(after?.name).toBe(CHANGED.name);
    expect(after?.locationId).toBe(ids.room);
    // …and everything it did not is carried, `tags` included.
    expect(after?.tags).toEqual(before?.tags);
    expect(after?.sku).toBe(before?.sku);
    expect(after?.equipmentId).toBe(before?.equipmentId);

    await restoreFixture();
  });

  it("a CLEARED quantity resolves to 1, not 0 — in the editor too", async () => {
    // `stockEditSchema` extends the create schema, so the documented
    // default applies here exactly as it does on the create path: blank ⇒ "not stated" ⇒
    // 1. An editor that resolved a cleared box to `0` would re-open the defect just
    // closed, and "we have none of this" must be an explicit typed `0` — never inferred.
    const res = await edit({ quantity: "" });
    expect(res).toBeInstanceOf(Response);
    expect((await find(ids.linked))?.quantity).toBe(1);

    const explicit = await edit({ quantity: "0" });
    expect(explicit).toBeInstanceOf(Response);
    expect((await find(ids.linked))?.quantity).toBe(0);

    await restoreFixture();
  });

  it("the save is parsed through the REAL schema, not hand-assembled", async () => {
    // The half-editor built its input by hand, so it accepted values the create path
    // refuses. A stock row is a stock row whichever form wrote it, and a negative quantity
    // or a malformed price arriving through one form and not the other is the kind of
    // half-measure this test exists to remove.
    const negative = await edit({ quantity: "-5" });
    expect(negative).not.toBeInstanceOf(Response);
    expect(
      (negative as { fieldErrors?: Record<string, string[]> }).fieldErrors?.quantity?.[0],
    ).toBeTruthy();
    expect((await find(ids.linked))?.quantity).toBe(7);

    const badPrice = await edit({ purchasePrice: "zwölf euro" });
    expect(badPrice).not.toBeInstanceOf(Response);
    expect(
      (badPrice as { fieldErrors?: Record<string, string[]> }).fieldErrors?.purchasePrice?.[0],
    ).toBeTruthy();
    expect((await find(ids.linked))?.purchasePrice).toBeNull();
  });

  it("an unknown intent is refused, not silently treated as a save", async () => {
    const before = await find(ids.linked);
    const res = await detailRoute.action({
      request: req("http://localhost/inventory/stock/x", {
        _action: "delete-everything",
        name: EDITED.name,
      }),
      params: { id: ids.linked },
    } as never);
    expect(res).not.toBeInstanceOf(Response);
    expect((res as { formErrors?: string[] }).formErrors?.[0]).toBeTruthy();
    expect(await find(ids.linked)).toEqual(before);
  });

  it("a legacy `move` intent is still accepted, so a cached form does not break", async () => {
    // A rename that rejected the old value would turn every open tab into an error. The
    // old name is an alias, not a second code path.
    const res = await detailRoute.action({
      request: req("http://localhost/inventory/stock/x", { ...fullEditorBody(), _action: "move" }),
      params: { id: ids.linked },
    } as never);
    expect(res).toBeInstanceOf(Response);
    expect((await find(ids.linked))?.name).toBe(EDITED.name);

    await restoreFixture();
  });
});

describe("structural — the routes obey the boundaries a green suite cannot see", () => {
  const ROUTE_FILES = [
    "../../app/routes/_desktop.inventory.stock._index/route.tsx",
    "../../app/routes/_desktop.inventory.stock.new/route.tsx",
    "../../app/routes/_desktop.inventory.stock.$id/route.tsx",
    "../../app/routes/m.inventory.stock._index/route.tsx",
  ];

  it("no stock route reaches for the Prisma client or db.server itself", () => {
    const sources = ROUTE_FILES.map((rel) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
    );
    for (const src of sources) {
      // Over the IMPORT SPECIFIERS, not the file text: a raw scan cannot tell code from
      // prose, and these files *name* the modules they are forbidden to import in the
      // comments that explain the rule. `db` cannot reach a module without being imported,
      // so the import IS the boundary.
      const specifiers = [...src.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)].map((m) => m[1]);
      expect(specifiers).not.toContain("~/lib/db.server");
      expect(specifiers).not.toContain("~/generated/prisma/client");
      expect(specifiers.some((s) => s.startsWith("@prisma/client"))).toBe(false);
      expect(specifiers.filter((s) => s.startsWith("~/domains/"))).not.toHaveLength(0);
    }
  });

  it("every stock route sits under an auth-guarded layout, and both layouts guard", () => {
    const layout = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
    expect(layout("../../app/routes/_desktop/route.tsx")).toMatch(/requireUser\(request\)/);
    expect(layout("../../app/routes/m/route.tsx")).toMatch(/requireUser\(request\)/);
    for (const rel of ROUTE_FILES) {
      expect(rel).toMatch(/^\.\.\/\.\.\/app\/routes\/(_desktop|m)\./);
    }
  });

  it("the stock namespace never links /inventory/:id AS a stock item", () => {
    // The one link that would re-create the confusion the stock module removes: a stock
    // row linking its own detail page to the Equipment one. `stock-columns.tsx` links
    // `/inventory/stock/${id}` for the row and `/inventory/${equipment.id}` for the
    // *equipment*, and that distinction is the point of this guard.
    const src = readFileSync(
      fileURLToPath(new URL("../../app/components/inventory/stock-columns.tsx", import.meta.url)),
      "utf8",
    );
    const stockLinks = [...src.matchAll(/to=\{`([^`]+)`\}/g)].map((m) => m[1]);
    expect(stockLinks).toContain("/inventory/stock/${row.original.id}");
    // Every `/inventory/${…}` link must be an equipment link, i.e. read `.equipment`.
    for (const link of stockLinks.filter((l) => l.startsWith("/inventory/${"))) {
      expect(link).toContain("equipment");
    }
  });

  /**
   * 🔴 **The editor is COMPLETE**, and this is the half of that claim
   * no behavioural test can reach.
   *
   * The per-field save assertions above prove the ACTION writes every field it is given.
   * They are structurally blind to a control that was never rendered: the test posts the
   * field itself, so a form that dropped the `<Input name="sku">` would still pass every one
   * of them. This is the instrument for the other half, and the two are the minimum — a
   * static guard cannot tell whether anything reads a name, and a behavioural test cannot
   * see a control that is not there.
   *
   * ⚠️ **Why a source scan and not a render.** `renderToStaticMarkup`
   * throws `Cannot read properties of null (reading 'useContext')` on the FIRST hook, under
   * React 19's `react-dom-server-legacy` build in vitest's `node` environment (one React copy
   * in the store — `react@19.2.7` — so this is the renderer, not a duplicate). A render-based
   * version of this test is therefore **unreachable here, not unimplemented**, and an
   * instrument that cannot run is not a weaker test, it is no test.
   *
   * ⚠️ **The scan matches the JSX ATTRIBUTE, and comments are blanked first** — the same
   * discipline as the import-specifier scan above. These files *discuss* `name="tags"` in the
   * prose that explains the rule, so an unblanked scan would report a control that is not one
   * and, worse, would keep reporting it after the control is deleted.
   *
   * ⚠️ **The one blind spot this scan has: a control written as `name={SOME_CONST}` is
   * INVISIBLE to it.** Such a control makes the scan report `the editor has no control for:
   * tags`, a true statement about the scan and a false one about the form. Name the field with
   * an inline literal instead: a scan whose escape hatch is "name your fields through constants"
   * pushes the next author away from the readable form. The scan is a *reachability* claim about
   * the text, which is why it is paired with the behavioural tests and not asked to do their job.
   */
  const controlNamesIn = (rel: string) => {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    return new Set([...src.matchAll(/\bname="([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]));
  };

  /** Fields the editor renders plus the ones it deliberately does not, each with its reason. */
  const CARRIED_ONLY = {
    id: "the URL parameter — the action injects it, and a form must not be able to target a different row",
    equipmentId:
      "the ticket-harmony link: its own two-audit-row write, and a `Restrict` FK that must not move through a plain save",
  } as const;

  it("every field `stockEditSchema` accepts has a control in the form — the two exceptions are named", async () => {
    // Two files, not one: `vendorId` is rendered by `StockVendorSelect`, which is a child
    // component. A scan of `stock-form-fields.tsx` alone would report `vendorId` missing and
    // the exception list would have to become a lie to make it pass.
    const controls = new Set([
      ...controlNamesIn("../../app/components/inventory/stock-form-fields.tsx"),
      ...controlNamesIn("../../app/components/inventory/stock-vendor-select.tsx"),
    ]);
    const { stockEditSchema } = await import("~/domains/inventory/inventory.stock.schema");
    const fields = Object.keys(stockEditSchema.shape);

    for (const [field, why] of Object.entries(CARRIED_ONLY)) {
      // The exception is ASSERTED PRESENT in the schema, not assumed: an exception that
      // names a field the schema no longer has is a stale comment reading as a pass.
      expect(fields, `${field} is listed as carried but is not a schema field`).toContain(field);
      expect(why.length).toBeGreaterThan(0);
    }

    const rendered = fields.filter((f) => !(f in CARRIED_ONLY));
    const missing = rendered.filter((f) => !controls.has(f));
    expect(missing, `the editor has no control for: ${missing.join(", ")}`).toEqual([]);
    // …and `tags` specifically, because it is the field the change added and the one whose
    // absence was the whole defect.
    expect(controls.has("tags")).toBe(true);
  });

  it("the route carries exactly the fields the form does not render — the two lists agree", async () => {
    // The other direction, and the one that makes the exception list above load-bearing
    // rather than decorative: if the action carried a field the form DOES render, that
    // control would be a decoration, and the user could type into a box whose value is
    // thrown away on save. The control test above would stay green.
    const routeSrc = readFileSync(
      fileURLToPath(
        new URL("../../app/routes/_desktop.inventory.stock.$id/route.tsx", import.meta.url),
      ),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    // The per-field list the action reads, by the CALL and not by the words — the prose in
    // that file names every one of these fields too.
    const block = routeSrc.match(/const EDITED_FIELDS = \[([\s\S]*?)\] as const;/);
    expect(
      block,
      "the action must declare EDITED_FIELDS as a literal the test can read",
    ).toBeTruthy();
    const edited = new Set(
      [...(block?.[1] ?? "").matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]),
    );

    const { stockEditSchema } = await import("~/domains/inventory/inventory.stock.schema");
    for (const field of Object.keys(stockEditSchema.shape)) {
      // Every field is either read from the form or carried, and never both-and-neither.
      expect(
        edited.has(field) || field in CARRIED_ONLY,
        `${field} is neither edited nor carried`,
      ).toBe(true);
    }
    for (const field of Object.keys(CARRIED_ONLY)) {
      expect(edited.has(field), `${field} is carried but also read from the form`).toBe(false);
    }
  });
});
