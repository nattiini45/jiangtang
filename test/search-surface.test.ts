import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";
import { SOURCE_TYPES, type SourceType } from "~/lib/search/sources.server";
import { reconcileAll, reindexSource } from "~/lib/search/indexer.server";
import type { SearchHit } from "~/lib/search/query.server";

/**
 * The /search + api.search + /admin/index surface over the seeded dev
 * corpus. `reconcileAll()` in beforeAll indexes whatever is seeded; the
 * exit assertions are that every hybrid hit resolves to a real row with a
 * real href, an exact serial reaches api.search, and /search serves lexical
 * results with no provider configured.
 */

const RUN = `search_surface_${Date.now().toString(36)}`;

let role: "ADMIN" | "MEMBER" = "MEMBER";
vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return {
    ...actual,
    requireUser: vi.fn(async () => ({ role }) as AuthUser),
    // requireRole calls the module-local requireUser, not this mocked export —
    // mock it directly with the real semantics.
    requireRole: vi.fn(async (_req: Request, r: string) => {
      if (r === "ADMIN" && role !== "ADMIN") throw new Response("Forbidden", { status: 403 });
      return { role } as AuthUser;
    }),
  };
});

const apiSearch = await import("~/routes/api.search/route");
const searchPage = await import("~/routes/_desktop.search/route");
const adminIndex = await import("~/routes/_desktop.admin.index/route");
const { runSearch } = await import("~/routes/api.search/search.server");
const { hybridSearch } = await import("~/lib/search/query.server");

const exists: Record<SourceType, (id: string) => Promise<unknown>> = {
  TASK: (id) => db.task.findUnique({ where: { id } }),
  TICKET: (id) => db.ticket.findUnique({ where: { id } }),
  NOTE: (id) => db.note.findUnique({ where: { id } }),
  PROJECT: (id) => db.project.findUnique({ where: { id } }),
  INVENTORY_ITEM: (id) => db.inventoryItem.findUnique({ where: { id } }),
  EQUIPMENT: (id) => db.equipment.findUnique({ where: { id } }),
  EVENT: (id) => db.event.findUnique({ where: { id } }),
  LOCATION: (id) => db.location.findUnique({ where: { id } }),
  ROOM: (id) => db.room.findUnique({ where: { id } }),
  VENDOR: (id) => db.vendor.findUnique({ where: { id } }),
};

let noteId = "";
const stockIds: string[] = [];

afterAll(async () => {
  await db.note.deleteMany({ where: { id: { in: [noteId].filter(Boolean) } } });
  await db.inventoryItem.deleteMany({ where: { id: { in: stockIds } } });
  await db.searchIndexJob.deleteMany({ where: { sourceId: { in: [noteId].filter(Boolean) } } });
});

describe("hybrid hits resolve to real rows (exit 1)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    await reconcileAll();
  });

  it("every hit across several queries exists and has an href", async () => {
    const queries = ["Hörsaal", "Kabel", "Ticket", "Projekt", "Lager"];
    const seen = new Set<string>();
    for (const q of queries) {
      const { results } = await hybridSearch(q, {
        limit: 10,
        // Scope to real source types — a concurrent eval-test run could leave
        // EVAL chunks in the shared dev DB whose href is intentionally null.
        sourceTypes: [...SOURCE_TYPES],
      });
      for (const hit of results) {
        const key = `${hit.sourceType}:${hit.sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const found = await exists[hit.sourceType as SourceType]?.(hit.sourceId);
        expect(found, `${key} must resolve to a row`).toBeTruthy();
        expect(hit.href, `${key} must have a page`).not.toBeNull();
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe("api.search (exit 2)", () => {
  it("an exact stock serial is found through the route", async () => {
    const item = await db.inventoryItem.create({
      data: { name: `${RUN} Router`, serial: `${RUN}-SN-4242` },
    });
    stockIds.push(item.id);
    const res = await apiSearch.loader({
      request: new Request(`http://localhost/api/search?q=${RUN}-SN-4242`),
    } as never);
    const data = (await res.json()) as { results: { type: string; id: string; href: string }[] };
    const hit = data.results.find((r) => r.type === "inventory-item" && r.id === item.id);
    expect(hit?.href).toBe(`/inventory/stock/${item.id}`);
  });

  it("runSearch keeps the stock identifier arm ahead of hybrid hits", async () => {
    const item = await db.inventoryItem.create({
      data: { name: `${RUN} Mischpult`, serial: `${RUN}-SN-7777` },
    });
    stockIds.push(item.id);
    const results = await runSearch(`${RUN}-SN-7777`);
    const mine = results.filter((r) => r.id === item.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.type).toBe("inventory-item");
  });
});

describe("/search page (exit 4)", () => {
  it("serves lexical results with a 200 when no provider is configured", async () => {
    role = "MEMBER";
    const note = await db.note.create({
      data: {
        title: `${RUN} Notiz Beschallung`,
        body: "PA-Setup für den Ablauf",
        authorId: (await db.user.findFirst())!.id,
      },
    });
    noteId = note.id;
    await reindexSource("NOTE", note.id);

    const data = (await searchPage.loader({
      request: new Request(`http://localhost/search?q=${RUN} Beschallung`),
    } as never)) as { results: SearchHit[]; degraded: string[]; semantic: boolean };
    expect(data.semantic).toBe(false);
    const hit = data.results.find((r) => r.sourceId === note.id);
    expect(hit).toBeDefined();
    expect(hit!.href).toBe(`/notes/${note.id}`);
    expect(hit!.sourceType).toBe("NOTE");
  });
});

describe("/admin/index", () => {
  it("is refused for non-admins", async () => {
    role = "MEMBER";
    await expect(
      adminIndex.loader({ request: new Request("http://localhost/admin/index") } as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("loads provider statuses and index stats for an admin", async () => {
    role = "ADMIN";
    const data = (await adminIndex.loader({
      request: new Request("http://localhost/admin/index"),
    } as never)) as {
      statuses: { capability: string; state: string }[];
      stats: { types: { sourceType: string }[]; activeModel: string | null };
      jobs: unknown[];
    };
    expect(data.statuses).toHaveLength(3);
    expect(data.statuses.every((s) => s.state === "none")).toBe(true);
    expect(data.stats.types.length).toBeGreaterThan(0);
  });
});
