import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

/**
 * The standing **URL → route-file** guard for the `/inventory` namespace.
 *
 * ⚠️ **Why this file exists at all, and why it is not a snapshot.** `/inventory/stock`
 * is a *static* segment, and a static segment with no route behind it does not 404:
 * the router falls through to the dynamic sibling `/inventory/:id` and hands the
 * canonical stock URL to the **Equipment detail page**. That shadow is silent — a
 * cursed link renders a real page — and a hand-written table alone would not stop it,
 * because a table that is never compared against the real route table reports health
 * for routes nobody looked at. So there are two halves here, and the second is the
 * real work:
 *
 *   1. a `TABLE` of `(url, expectedRouteId)` — the **claim**, and
 *   2. a **completeness loop** — every route entry the real tree returns under the
 *      namespace must be the winner of some `TABLE` row, so a route that is added without
 *      its own line goes **red**.
 *
 * ### Why the router is consulted at all
 *
 * Both route-test precedents in this repo (`test/routes/locations-routes.test.ts`,
 * `app/domains/tickets/__tests__/m-tickets-routes.test.ts`) import the module and call
 * `loader({ request, params })` directly, so the URL is a string inside a `Request` and
 * **the router is never asked which route a URL belongs to**. Neither can see this bug.
 * The check below therefore asks the router directly.
 *
 * ### Why `flatRoutes()` runs here at all
 *
 * `flatRoutes()` is documented nowhere as standalone-callable, and a handoff once
 * recorded as a standing fact that it *"cannot be called standalone — it needs the Vite
 * plugin context and throws through `getAppDirectory`"*. **That is a claim about a call
 * site, not about the library**: `getAppDirectory()`'s entire body is
 * `invariant(globalThis.__reactRouterAppDirectory); return globalThis.__reactRouterAppDirectory;`
 * — it reads a global the Vite plugin merely *sets*. So: one assignment, the real ranked
 * table, the real `matchRoutes`, against the real tree in place. No CLI, no copy, and no
 * text parsing.
 */

/** One assignment, and the instrument works. `~` is banned: `no-explicit-any` is `warn`. */
type AppDirectoryGlobal = { __reactRouterAppDirectory?: string };
(globalThis as AppDirectoryGlobal).__reactRouterAppDirectory = fileURLToPath(
  new URL("../../app", import.meta.url),
);

const { flatRoutes } = await import("@react-router/fs-routes");
const { matchRoutes } = await import("react-router");

type RouteEntry = { id?: string; path?: string; index?: boolean; children?: RouteEntry[] };

/** The real ranked table, built once, from the real tree. */
const ROUTES: RouteEntry[] = (await flatRoutes()) as RouteEntry[];

/** The winning route FILE for a URL, or `null` when nothing matches. */
const winnerOf = (routes: RouteEntry[], url: string): string | null => {
  const match = matchRoutes(routes as never, url) as Array<{ route: { id?: string } }> | null;
  return match?.at(-1)?.route.id ?? null;
};

/** The table under test: every verdict goes through this ONE function. */
const verdict = (routes: RouteEntry[], url: string) => winnerOf(routes, url);

/** The namespace this guard is scoped to. Widening it is one constant. */
const NAMESPACE = "inventory";

/**
 * Every entry the real tree returns under the namespace, **flat**, with each entry
 * tagged by whether it can own a URL at all.
 *
 * ⚠️ **"Can own a URL" is DERIVED, never listed — and the derivation is not the obvious
 * one.** A pathless layout renders its children and is the winner of nothing, so
 * demanding it appear in `TABLE` would make the loop unsatisfiable; hand-listing the two
 * known layouts would make it a second stale table that goes quietly wrong the first time
 * someone adds a third. So the test is structural — **an entry owns a URL if it is a
 * `index` or a leaf** (`!children.length`) — and *not* "has a non-empty `path`", which is
 * the guess a first pass makes and which **measurement here refuted**:
 *
 * ```
 * routes/_desktop.inventory       path "inventory"  index false  5 children   → layout
 * routes/_desktop.inventory.models path "models"    index false  3 children   → layout
 * routes/_desktop.inventory._index  path null      index true   0 children   → page
 * routes/_desktop.inventory.$id     path ":id"     index false  0 children   → page
 * ```
 *
 * A transparent layout **keeps its `path`** and is simply never the deepest match, so
 * `path.length > 0` classifies both layouts as pages — which would have made the
 * completeness loop demand table rows for two files that can never own a URL, i.e. a
 * permanently red guard, and a red guard is a guard nobody reads. (This is also the
 * correction to the documented census.)
 */
function namespaceEntries(routes: RouteEntry[]): Array<{ id: string; canOwnUrl: boolean }> {
  const out: Array<{ id: string; canOwnUrl: boolean }> = [];
  const walk = (entries: RouteEntry[], parentOwnsUrl: boolean) => {
    for (const entry of entries) {
      const id = entry.id ?? "";
      if (!id.includes(NAMESPACE)) {
        // Still walk into it: an ancestor can be outside the namespace while a
        // descendant is inside it, and stopping here would under-count silently.
        if (entry.children) walk(entry.children, parentOwnsUrl);
        continue;
      }
      const canOwnUrl = Boolean(entry.index) || !entry.children?.length;
      out.push({ id, canOwnUrl });
      if (entry.children) walk(entry.children, canOwnUrl);
    }
  };
  walk(routes, true);
  return out;
}

/**
 * The claim, row by row. `/inventory` and `/inventory/:id` **stay `Equipment`**
 * that is the whole point of the namespace existing, and six components plus seven
 * producers link there as equipment detail, so a row asserting otherwise would be
 * asserting a regression as if it were a feature.
 *
 * Concrete ids, not `:id` placeholders: `matchRoutes` takes a real URL, and a table of
 * patterns would be a second thing to keep in sync with the first.
 */
const TABLE: Array<{ url: string; id: string }> = [
  // — the existing owners —
  { url: "/inventory", id: "routes/_desktop.inventory._index" },
  { url: "/inventory/gear-01", id: "routes/_desktop.inventory.$id" },
  { url: "/inventory/new", id: "routes/_desktop.inventory.new" },
  { url: "/inventory/import", id: "routes/_desktop.inventory.import" },
  { url: "/inventory/models", id: "routes/_desktop.inventory.models._index" },
  { url: "/inventory/models/new", id: "routes/_desktop.inventory.models.new" },
  { url: "/inventory/models/cat-01", id: "routes/_desktop.inventory.models.$id" },
  // — the stock routes —
  { url: "/inventory/stock", id: "routes/_desktop.inventory.stock._index" },
  { url: "/inventory/stock/new", id: "routes/_desktop.inventory.stock.new" },
  { url: "/inventory/stock/import", id: "routes/_desktop.inventory.stock.import" },
  { url: "/inventory/stock/item-01", id: "routes/_desktop.inventory.stock.$id" },
  { url: "/m/inventory/stock", id: "routes/m.inventory.stock._index" },
];

// ── The table, resolved through the real router. ────────────

describe("route resolution — the /inventory namespace, through the real router", () => {
  it.each(TABLE)("$url resolves to $id", ({ url, id }) => {
    expect(verdict(ROUTES, url)).toBe(id);
  });

  it("resolves a URL that genuinely has no route to the catch-all, rather than to a neighbour", () => {
    // `/equipment` is NOT a route: the Equipment surface *is* `/inventory`
    // A guard that reported a winner for every
    // URL would be the *symptom* of the bug it exists to catch. Only the top-level
    // splat may claim such a URL, never an inventory route.
    expect(verdict(ROUTES, "/equipment")).toBe("routes/$");
    expect(verdict(ROUTES, "/inventory/nope/deeper")).toBe("routes/$");
  });
});

// ── The completeness loop. This is the guard's real work. ──

describe("route resolution — the table cannot lie by omission", () => {
  const entries = namespaceEntries(ROUTES);
  const winners = new Set(TABLE.map((row) => row.id));

  it("sees the namespace, AND discriminates pages from layouts", () => {
    // The control for the control. `matchRoutes`/`flatRoutes` are 0 hits in the rest
    // of the suite, so a silently-empty table — or a derivation that called
    // everything a page — would make the loop below vacuous and green.
    //
    // ⚠️ **No magic count.** The census is deliberately not asserted as a number: it
    // moves with every route in the namespace (the stock importer adds `/inventory/stock/import`),
    // and a hard-coded total would be a second thing to keep in sync — the failure mode
    // this file exists to end. What must hold is that the walk finds routes, and that
    // it tells layouts and pages apart; exact correspondence is pinned one test down,
    // in both directions.
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((e) => e.canOwnUrl).length).toBeGreaterThan(0);
    expect(entries.filter((e) => !e.canOwnUrl).length).toBeGreaterThan(0);
  });

  it("every route entry under /inventory that can own a URL is claimed by a table row", () => {
    const unclaimed = entries.filter((e) => e.canOwnUrl && !winners.has(e.id)).map((e) => e.id);
    // A route that adds `_desktop.inventory.stock.edit` and forgets this line lands
    // here, naming the route — the failure this whole file exists to make possible.
    expect(
      unclaimed,
      `unclaimed route entries under /${NAMESPACE}: ${unclaimed.join(", ") || "none"}`,
    ).toEqual([]);
  });

  it("every table row names a route the real tree actually has", () => {
    // The other direction: a row left behind by a deleted or renamed route is a claim
    // about a file that no longer exists, which is the same defect wearing a
    // different hat — and it would keep passing while asserting something false.
    const known = new Set(entries.map((e) => e.id));
    const ghosts = TABLE.filter((row) => !known.has(row.id)).map(
      (row) => `${row.url} -> ${row.id}`,
    );
    expect(ghosts, `table rows with no route in the tree: ${ghosts.join(", ") || "none"}`).toEqual(
      [],
    );
  });

  it("no two table rows claim the same file, and every file is claimed once", () => {
    // Catches a copy-pasted row (two URLs, one expected id) — which would quietly
    // stop covering whichever URL it was meant to cover.
    const ids = TABLE.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    const claimable = entries
      .filter((e) => e.canOwnUrl)
      .map((e) => e.id)
      .sort();
    expect([...ids].sort()).toEqual(claimable);
  });

  it("the two namespace layouts are pathless, so they own no URL and claim nothing", () => {
    // Named rather than assumed: this asserts the DERIVATION is still true for the
    // layouts that exist today, so a future pathless layout shows up as a shape
    // change rather than as a loop that quietly stopped checking anything.
    const layouts = entries.filter((e) => !e.canOwnUrl).map((e) => e.id);
    expect(layouts).toEqual(["routes/_desktop.inventory", "routes/_desktop.inventory.models"]);
    for (const url of TABLE.map((r) => r.url)) {
      expect(layouts).not.toContain(verdict(ROUTES, url));
    }
  });
});

// ── The negative control. A guard that cannot fail is worse ──
//     than none, so this removes the routes under test from the array the
//     instrument ALREADY returned — in memory, no second tree, no write — and
//     requires the same verdict function to report a different winner.

/**
 * The real table with every `inventory.stock` entry removed **at any depth** — and
 * "at any depth" is not decoration.
 *
 * ⚠️ **The first version of this control filtered only the TOP-LEVEL array and removed
 * nothing at all**, because `flatRoutes()` returns 11 top-level entries and the stock
 * routes are *nested* under `routes/_desktop`. The control's own test caught it: the
 * removal count came back 0, and `/inventory/stock` still resolved to
 * `stock._index` after the "removal". A control that silently removes nothing looks
 * exactly like a control that works, right up until the assertion it was written to
 * protect stops meaning anything — which is the failure this file exists to end, wearing
 * a different hat.
 */
function withoutStock(entries: RouteEntry[]): RouteEntry[] {
  const out: RouteEntry[] = [];
  for (const entry of entries) {
    // Drop the entry and its whole subtree: a nested layout would keep matching with
    // zero children otherwise.
    if (entry.id?.includes("inventory.stock")) continue;
    out.push(entry.children ? { ...entry, children: withoutStock(entry.children) } : entry);
  }
  return out;
}

/** Every id in the table, flattened — used to name exactly what the control removed. */
function allIds(entries: RouteEntry[]): string[] {
  return entries.flatMap((e) => [
    ...(e.id ? [e.id] : []),
    ...(e.children ? allIds(e.children) : []),
  ]);
}

describe("route resolution — negative control (the shadow this guard exists for)", () => {
  const WITHOUT_STOCK = withoutStock(ROUTES);
  const removedIds = allIds(ROUTES).filter((id) => !allIds(WITHOUT_STOCK).includes(id));

  it("the control removes exactly the stock routes, and names them", () => {
    // A filter that matched nothing would leave ROUTES intact, the control would report
    // "no verdict changed", and the two tests below would then assert nothing at all.
    // Sorted on both sides: the ORDER `flatRoutes()` emits entries in is an implementation
    // detail, and pinning it would make this control fail for a reason that has nothing
    // to do with whether it removed the right routes.
    expect([...removedIds].sort()).toEqual(
      [
        "routes/_desktop.inventory.stock.$id",
        "routes/_desktop.inventory.stock._index",
        "routes/_desktop.inventory.stock.new",
        // Added the stock importer under the same namespace, so the control
        // removes it too. The list is exact on purpose — an exact list is the only
        // thing that would notice a `withoutStock` filter that quietly stopped
        // matching this one id.
        "routes/_desktop.inventory.stock.import",
        "routes/m.inventory.stock._index",
      ].sort(),
    );
    expect(allIds(ROUTES).length).toBeGreaterThan(allIds(WITHOUT_STOCK).length);
  });

  it("/inventory/stock falls back to the Equipment detail page when stock routes are absent", () => {
    // The exact shadow: the canonical stock URL rendered by the wrong page, silently.
    expect(verdict(ROUTES, "/inventory/stock")).toBe("routes/_desktop.inventory.stock._index");
    expect(verdict(WITHOUT_STOCK, "/inventory/stock")).toBe("routes/_desktop.inventory.$id");
  });

  it("the same verdict function changes its answer on more than one URL", () => {
    const changed = TABLE.filter(
      (row) => verdict(ROUTES, row.url) !== verdict(WITHOUT_STOCK, row.url),
    );
    // Not an exact count: a stock sub-route added later must change this
    // number, and a test that failed on that would pressure a reviewer into
    // weakening it. The specific flip above is the assertion that must hold.
    expect(changed.length).toBeGreaterThan(1);
    expect(changed.map((c) => c.url)).toContain("/inventory/stock");
  });

  it("the pre-existing equipment owners are UNAFFECTED — the control moves only stock", () => {
    // Without this, a control that changed every verdict would also satisfy the test
    // above, and the file would be asserting a router that reshuffles the namespace.
    for (const row of TABLE.filter((r) => !r.id.includes("stock"))) {
      expect(verdict(WITHOUT_STOCK, row.url)).toBe(row.id);
    }
  });
});
