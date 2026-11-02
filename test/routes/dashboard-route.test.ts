import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";

/**
 * `/` — the workspace dashboard. The loader composes one real query per
 * card; the action runs the demo seed through `txWithAudit`, admin-only, and
 * idempotent by stable ids — a second POST writes nothing.
 */
const RUN = `dashboard_route_${Date.now().toString(36)}`;

const TEST_USER: AuthUser = {
  id: `${RUN}-user`,
  name: "Dashboard Tester",
  email: `${RUN}@test.local`,
  initials: "DT",
  role: "MEMBER",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return {
    ...actual,
    requireUser: vi.fn(async () => TEST_USER),
    // Faithful stand-in for the real check — the action's load-demo branch must
    // route through it; a MEMBER produces the same 403 Response the real one does.
    requireRole: vi.fn(async (_req: Request, role: string) => {
      if (role === "ADMIN" && TEST_USER.role !== "ADMIN") {
        throw new Response("Forbidden", { status: 403 });
      }
      return TEST_USER;
    }),
  };
});

const route = await import("~/routes/_desktop._index/route");

// The actor-aware demo seed assigns work to the loading admin — the FK needs a
// real User row, so the mock actor gets one (and its rows are removed after).
beforeAll(async () => {
  await db.user.create({
    data: {
      id: TEST_USER.id,
      name: TEST_USER.name,
      email: TEST_USER.email,
      initials: TEST_USER.initials,
      role: "MEMBER",
      isActive: true,
    },
  });
});

afterAll(async () => {
  await db.taskAssignees.deleteMany({ where: { userId: TEST_USER.id } });
  const tickets = await db.ticket.findMany({
    where: { assignees: { some: { id: TEST_USER.id } } },
    select: { id: true },
  });
  for (const t of tickets) {
    await db.ticket.update({
      where: { id: t.id },
      data: { assignees: { disconnect: { id: TEST_USER.id } } },
    });
  }
  await db.user.delete({ where: { id: TEST_USER.id } });
  await db.$disconnect();
});

const load = () =>
  route.loader({ request: new Request("http://localhost/") } as never) as Promise<{
    isAdmin: boolean;
    due: { dueTodayCount: number; overdueCount: number };
    blocked: unknown[];
    myWork: { taskCount: number; estimateMinutes: number };
    myTickets: { ticketCount: number };
    recent: unknown[];
    storage: { attachmentCount: number; totalBytes: number; backend: string };
    searchHealth: { state: string; note: string; chunks: number; embedded: number };
    empty: boolean;
  }>;

const postDemo = () =>
  route.action({
    request: new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "intent=load-demo",
    }),
  } as never) as Promise<{ loaded: boolean; created: number; skipped: number }>;

describe("/ loader", () => {
  it("composes every card from its real query", async () => {
    const data = await load();
    expect(data.empty).toBe(false); // the dev corpus is seeded
    expect(typeof data.due.dueTodayCount).toBe("number");
    expect(Array.isArray(data.blocked)).toBe(true);
    expect(typeof data.myWork.estimateMinutes).toBe("number");
    expect(typeof data.myTickets.ticketCount).toBe("number");
    expect(Array.isArray(data.recent)).toBe(true);
    // Live health (was a "…folgt" stub): a real state + counts.
    expect(["lexical", "semantisch", "gestört"]).toContain(data.searchHealth.state);
    expect(data.searchHealth.note.length).toBeGreaterThan(0);
    expect(data.searchHealth.chunks).toBeGreaterThan(0);
    expect(data.storage.backend.length).toBeGreaterThan(0);
  });
});

describe("/ action — load-demo", () => {
  it("refuses a MEMBER before the seed runs", async () => {
    TEST_USER.role = "MEMBER";
    await expect(postDemo()).rejects.toMatchObject({ status: 403 });
  });

  it("an ADMIN can run it — and running it twice writes nothing the second time", async () => {
    TEST_USER.role = "ADMIN";
    const first = await postDemo();
    expect(first.loaded).toBe(true);
    const second = await postDemo();
    // Idempotent by stable ids: whatever the first run did, the second creates zero.
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(first.created + first.skipped);
    TEST_USER.role = "MEMBER";
  });
});
