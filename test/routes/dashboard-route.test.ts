import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";
import { defaultHomeLayout } from "~/domains/dashboard/home-layout";

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
const preference = await import("~/routes/home-layout/route");

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

const load = () => route.loader({ request: new Request("http://localhost/") } as never);

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
    expect(data.home.layout).toEqual([
      { id: "faults", mode: "highlight" },
      { id: "due", mode: "show" },
      { id: "today", mode: "show" },
      { id: "mine", mode: "show" },
      { id: "activity", mode: "show" },
    ]);
    expect(typeof data.home.faults.roomCount).toBe("number");
    expect(Array.isArray(data.home.due.rounds)).toBe(true);
    expect(Array.isArray(data.home.today.events)).toBe(true);
    expect(typeof data.home.mine.taskCount).toBe("number");
    expect(typeof data.home.mine.ticketCount).toBe("number");
    expect(Array.isArray(data.home.activity)).toBe(true);
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

describe("home preferences", () => {
  it("saves only the authenticated actor even if another user ID is submitted", async () => {
    const layout = defaultHomeLayout();
    layout[4].mode = "hide";
    const result = await preference.action({
      request: new Request("http://localhost/home-layout", {
        method: "POST",
        body: new URLSearchParams({ layout: JSON.stringify(layout), userId: "forged-user" }),
      }),
    } as never);
    expect(result).toEqual({ ok: true });
    expect((await load()).home.layout).toEqual(layout);
    expect(await db.user.count({ where: { id: "forged-user" } })).toBe(0);
  });

  it.each([
    "not-json",
    "[]",
    JSON.stringify([...defaultHomeLayout().slice(0, 4), { id: "faults", mode: "show" }]),
  ])(
    "rejects malformed or duplicate layouts without overwriting the saved preference",
    async (layout) => {
      const previous = (await load()).home.layout;
      const response = await preference.action({
        request: new Request("http://localhost/home-layout", {
          method: "POST",
          body: new URLSearchParams({ layout }),
        }),
      } as never);
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(422);
      expect((await load()).home.layout).toEqual(previous);
    },
  );
});
