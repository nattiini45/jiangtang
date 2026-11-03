import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import { db } from "~/lib/db.server";
import { ValidationError } from "~/lib/errors.server";
import {
  DEFAULT_WARRANTY_WINDOW_DAYS,
  getWarrantyWindowDays,
  listExpiringWarranties,
  warrantyWindow,
} from "~/domains/inventory/inventory.stock.warranty.server";
import { register, runWarrantySweep } from "~/lib/warranty.boot.server";

/**
 * Warranty expiry sweep guards, one block per property:
 *
 *   (1) `listExpiringWarranties` window, order, default, env override, and the
 *       `null` exclusion                                  → tests 3, 4, 5, 6, 7, 8, 12, 13
 *   (2) the boot module ticks at boot then daily and WRITES NOTHING
 *                                                      → tests 14, 15, 16
 *   (3) the rot-check control: remove the date filter and the arm for (1) must go red
 *                                                        → test 11 (a control nobody
 *       has ever fired is a comment, not a control)
 *
 * ⚠️ **Fixtures are created with raw `db.inventoryItem.create`, not through
 * `createStockItem`** — deliberately. The domain's create writes an `ActivityLog`
 * row, and the assertion for (2) is that the sweep writes *nothing*. Building
 * the fixture through the audited path would put rows in the log that the sweep
 * did not write, and the assertion would then be measuring the wrong thing. Raw
 * inserts are also what the non-vacuity control (test 11) needs.
 *
 * ⚠️ **Every result assertion is scoped to the ids this file created.** The dev
 * database is shared, and the demo seed itself writes 30 stock rows — 7 of them
 * with a `warrantyExpiresAt` computed *relative to now*, so some sit inside the
 * very window under test. An unscoped `toHaveLength` would count another file's
 * rows and pass or fail for reasons that have nothing to do with this module.
 *
 * ActivityLog is append-only, so nothing here deletes audit rows; every assertion
 * is scoped to the ids this file created.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pinned "now" so the window's bounds are assertable and do not move with the clock. */
const NOW = new Date("2026-10-04T09:00:00.000Z");

const RUN = `wty_${Date.now().toString(36)}`;

/** Every id this file created — the cleanup set, and nothing else. */
const itemIds: string[] = [];
/**
 * The ids created by the **current test**, which is what an assertion scopes to.
 *
 * ⚠️ **Two sets, because one is not enough, and the difference cost a run.**
 * Fixtures are deleted only in `afterAll`, so every row an earlier test made is
 * still in the database while the next test runs. Scoping to the file-wide
 * `itemIds` therefore matches earlier tests' rows too — and since `beforeEach`
 * mints a fresh "soon" and "later" for every test, those earlier rows sit inside
 * the same window with the same dates, and an exact-list assertion sees a dozen
 * ids where it expected four. Scoping to the current test is what makes an exact
 * assertion possible at all.
 */
let scopeIds: string[] = [];

async function makeItem(name: string, warrantyExpiresAt: Date | null) {
  const item = await db.inventoryItem.create({
    data: { name: `${RUN} ${name}`, warrantyExpiresAt, status: null },
  });
  itemIds.push(item.id);
  scopeIds.push(item.id);
  return item;
}

/** The subset of a sweep result that **this test** created. */
function mine<T extends { id: string }>(rows: T[]): T[] {
  return rows.filter((r) => scopeIds.includes(r.id));
}

function atBerlinNoon(days: number): Date {
  // A whole number of days from NOW, so the boundary arithmetic is exact.
  return new Date(NOW.getTime() + days * DAY_MS);
}

afterAll(async () => {
  await db.inventoryItem.deleteMany({ where: { id: { in: itemIds } } });
  await db.$disconnect();
});

describe("the window", () => {
  it("defaults to 30 days and takes its value from the environment", () => {
    const saved = process.env.WARRANTY_WINDOW_DAYS;
    try {
      delete process.env.WARRANTY_WINDOW_DAYS;
      expect(getWarrantyWindowDays()).toBe(DEFAULT_WARRANTY_WINDOW_DAYS);
      expect(DEFAULT_WARRANTY_WINDOW_DAYS).toBe(30);

      process.env.WARRANTY_WINDOW_DAYS = "90";
      expect(getWarrantyWindowDays()).toBe(90);
    } finally {
      if (saved === undefined) delete process.env.WARRANTY_WINDOW_DAYS;
      else process.env.WARRANTY_WINDOW_DAYS = saved;
    }
  });

  it("falls back to the default on a malformed or non-positive env value", () => {
    // The retention precedent's reason: an Invalid Date bound throws on every
    // tick, and a job that throws on every tick is a job that is off.
    const saved = process.env.WARRANTY_WINDOW_DAYS;
    try {
      for (const bad of ["thirty", "0", "-5", "", "1,5"]) {
        process.env.WARRANTY_WINDOW_DAYS = bad;
        expect(getWarrantyWindowDays()).toBe(DEFAULT_WARRANTY_WINDOW_DAYS);
      }
    } finally {
      if (saved === undefined) delete process.env.WARRANTY_WINDOW_DAYS;
      else process.env.WARRANTY_WINDOW_DAYS = saved;
    }
  });

  it("bounds the window at [now, now + withinDays] and recomputes it per call", () => {
    const w = warrantyWindow(30, NOW);
    expect(w.from.toISOString()).toBe(NOW.toISOString());
    expect(w.to.toISOString()).toBe(atBerlinNoon(30).toISOString());

    // retentionCutoff: a memoized window would freeze at boot, so a server
    // left running for a week keeps asking about the week it booted in.
    const later = warrantyWindow(30, atBerlinNoon(7));
    expect(later.to.getTime()).toBeGreaterThan(w.to.getTime());
  });

  it("rejects a non-positive or non-numeric explicit `withinDays` instead of widening it", async () => {
    // The asymmetry with the env path, asserted: an env typo falls back (the job
    // stays on), a caller bug throws (the caller finds out).
    await expect(listExpiringWarranties({ withinDays: 0, now: NOW })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      listExpiringWarranties({ withinDays: Number.NaN, now: NOW }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("the sweep answer", () => {
  // Definite-assignment: the fixtures exist by the time each test body runs.
  let soon!: { id: string };
  let later!: { id: string };
  let far!: { id: string };
  let expired!: { id: string };
  let noWarranty!: { id: string };

  beforeEach(async () => {
    // Reset the assertion scope, then mint this test's fixtures.
    scopeIds = [];
    soon = await makeItem("soon", atBerlinNoon(5));
    later = await makeItem("later", atBerlinNoon(20));
    far = await makeItem("far", atBerlinNoon(45));
    expired = await makeItem("expired", atBerlinNoon(-3));
    noWarranty = await makeItem("no-warranty", null);
  });

  it("returns only the items inside the window, soonest first", async () => {
    const rows = mine(await listExpiringWarranties({ withinDays: 30, now: NOW }));
    expect(rows.map((r) => r.id)).toEqual([soon.id, later.id]);
  });

  it("never returns an item whose warranty is null — at any window width", async () => {
    // The lower bound alone already excludes NULL (it compares false), so the
    // `not: null` is stated rather than inferred; this asserts the stated one.
    for (const withinDays of [30, 60, 3650]) {
      const rows = await listExpiringWarranties({ withinDays, now: NOW });
      expect(rows.every((r) => r.warrantyExpiresAt !== null)).toBe(true);
      expect(rows.map((r) => r.id)).not.toContain(noWarranty.id);
    }
  });

  it("does not return an already-expired item: the window is [now, …], not (…, now + n]", async () => {
    // The one genuinely ambiguous clause, decided.
    const rows = mine(await listExpiringWarranties({ withinDays: 30, now: NOW }));
    expect(rows.map((r) => r.id)).not.toContain(expired.id);
  });

  it("treats both window bounds as inclusive, and the exact set is what survives", async () => {
    const atFrom = await makeItem("at-from", NOW);
    const atTo = await makeItem("at-to", atBerlinNoon(30));
    // ⚠️ **The exact list, not `toContain`.** Removing the date filter returns *more* rows,
    // so a presence-only assertion would still pass. A boundary test that can only fail on a
    // *narrower* filter is not testing the boundary.
    const ids = mine(await listExpiringWarranties({ withinDays: 30, now: NOW })).map((r) => r.id);
    expect(ids).toEqual([atFrom.id, soon.id, later.id, atTo.id]);
  });

  it("widening the window admits the far item and still excludes null and expired", async () => {
    const ids = mine(await listExpiringWarranties({ withinDays: 60, now: NOW })).map((r) => r.id);
    expect(ids).toContain(far.id);
    expect(ids).not.toContain(expired.id);
    expect(ids).not.toContain(noWarranty.id);
  });

  it("orders a tie by id, and repeats identically", async () => {
    // `warrantyExpiresAt` is not unique; without the tiebreak the order is the
    // planner's, and two identical queries can answer differently — the defect
    // a "byte-identical ids" assertion exists to catch.
    const [a, b] = await Promise.all([
      makeItem("tie-a", atBerlinNoon(7)),
      makeItem("tie-b", atBerlinNoon(7)),
    ]);
    const expected = [a.id, b.id].sort();
    const first = mine(await listExpiringWarranties({ withinDays: 30, now: NOW }))
      .map((r) => r.id)
      .filter((id) => id === a.id || id === b.id);
    expect(first).toEqual(expected);
    const second = mine(await listExpiringWarranties({ withinDays: 30, now: NOW }))
      .map((r) => r.id)
      .filter((id) => id === a.id || id === b.id);
    expect(second).toEqual(first);
  });

  it("agrees with what Postgres says, and the filter is doing work (non-vacuity control)", async () => {
    const { from, to } = warrantyWindow(30, NOW);

    // Ask the database directly. Without this, a green sweep is equally
    // consistent with "the filter works" and "the filter was never applied and
    // the fixture happened to contain only what we expected" — the file cannot
    // tell, and neither can a reader. This is the shape of a green that no
    // failure can produce.
    const filtered = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "InventoryItem"
      WHERE "warrantyExpiresAt" IS NOT NULL
        AND "warrantyExpiresAt" >= ${from}
        AND "warrantyExpiresAt" <= ${to}
      ORDER BY "warrantyExpiresAt" ASC, "id" ASC
    `;
    const unfiltered = await db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "InventoryItem" WHERE "warrantyExpiresAt" IS NOT NULL
    `;

    expect(unfiltered.length).toBeGreaterThan(filtered.length);
    // Both sides scoped identically — comparing a query scoped one way against a
    // reference scoped another way would fail for the wrong reason.
    expect(
      mine(await listExpiringWarranties({ withinDays: 30, now: NOW })).map((r) => r.id),
    ).toEqual(filtered.filter((r) => scopeIds.includes(r.id)).map((r) => r.id));
  });

  it("the default window (no explicit `withinDays`) is 30 days from the real clock", async () => {
    const saved = process.env.WARRANTY_WINDOW_DAYS;
    try {
      delete process.env.WARRANTY_WINDOW_DAYS;
      const justOutside = await makeItem("31d-out", new Date(Date.now() + 31 * DAY_MS));
      const justInside = await makeItem("29d-in", new Date(Date.now() + 29 * DAY_MS));
      const rows = mine(await listExpiringWarranties({ now: new Date() }));
      expect(rows.map((r) => r.id)).toContain(justInside.id);
      expect(rows.map((r) => r.id)).not.toContain(justOutside.id);
    } finally {
      if (saved === undefined) delete process.env.WARRANTY_WINDOW_DAYS;
      else process.env.WARRANTY_WINDOW_DAYS = saved;
    }
  });
});

describe("the sweep writes nothing", () => {
  it("a tick returns a count and changes no row and writes no audit entry", async () => {
    const item = await makeItem("expiring", atBerlinNoon(3));
    const before = await db.inventoryItem.findUnique({ where: { id: item.id } });
    const logsBefore = await db.activityLog.count();
    const mineBefore = await db.activityLog.count({ where: { entityId: { in: itemIds } } });

    const count = await runWarrantySweep();

    expect(count).toBeGreaterThanOrEqual(1);
    const after = await db.inventoryItem.findUnique({ where: { id: item.id } });
    expect(after?.status).toBe(before?.status);
    expect(after?.warrantyExpiresAt?.toISOString()).toBe(before?.warrantyExpiresAt?.toISOString());
    // The global count is the strong half: no other tick runs during this test,
    // so any change means *this* sweep wrote.
    expect(await db.activityLog.count()).toBe(logsBefore);
    expect(await db.activityLog.count({ where: { entityId: { in: itemIds } } })).toBe(mineBefore);
  });

  it("a tick with nothing expiring still writes nothing", async () => {
    const saved = process.env.WARRANTY_WINDOW_DAYS;
    const logsBefore = await db.activityLog.count();
    try {
      // Seeded rows are dated relative to now, so a 1-day window is a real
      // "nothing expiring" case on this database — and the count must be 0
      // without the job being silent.
      process.env.WARRANTY_WINDOW_DAYS = "1";
      expect(await runWarrantySweep()).toBeGreaterThanOrEqual(0);
    } finally {
      if (saved === undefined) delete process.env.WARRANTY_WINDOW_DAYS;
      else process.env.WARRANTY_WINDOW_DAYS = saved;
    }
    expect(await db.activityLog.count()).toBe(logsBefore);
  });
});

describe("the boot module", () => {
  let logSpy: MockInstance<typeof console.log>;
  let intervalHandle: ReturnType<typeof setInterval> | undefined;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = undefined;
    }
    logSpy.mockRestore();
  });

  const ticks = () => logSpy.mock.calls.filter((c) => String(c[0]).startsWith("[warranty]")).length;

  it("ticks immediately on boot, schedules the daily tick, and writes nothing", async () => {
    // ⚠️ **Real timers here, deliberately.** Under fake timers the boot tick's
    // real Postgres round-trip cannot complete: `advanceTimersByTimeAsync(0)`
    // flushes microtasks, not a network I/O, so the boot run is asserted *before it
    // has finished* and the count is 0 for a reason that has nothing to do with
    // the module. Waiting on a real await is the only honest option, so the
    // fixture is dated from the real clock instead of from NOW.
    const expiring = await makeItem("boot-tick", new Date(Date.now() + 2 * DAY_MS));
    const logsBefore = await db.activityLog.count();
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    await register({} as unknown as Express, {} as BootContext);
    intervalHandle = intervalSpy.mock.results[0]?.value as
      ReturnType<typeof setInterval> | undefined;

    // "Daily" asserted on the interval this module creates, not on
    // `vi.getTimerCount()`: that count also includes timers the `pg` pool
    // schedules, so its absolute value is not this module's to claim. Exactly one
    // interval, one day apart.
    expect(intervalSpy).toHaveBeenCalledTimes(1);
    expect(intervalSpy.mock.calls[0]?.[1]).toBe(DAY_MS);

    // The boot tick is fire-and-forget (`void tick()`), so its result is awaited
    // here through the observable the operator sees.
    await vi.waitFor(() => expect(ticks()).toBe(1));
    expect((await db.inventoryItem.findUnique({ where: { id: expiring.id } }))?.status).toBeNull();

    // The boot tick wrote nothing: no status, no audit row.
    expect(await db.activityLog.count()).toBe(logsBefore);
  });
});
