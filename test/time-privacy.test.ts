import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";
import {
  getRunningEntry,
  getTimeEntry,
  getWeekTimesheet,
  listWeekEntries,
} from "~/domains/time/time.queries.server";
import {
  createTimeEntry,
  deleteTimeEntry,
  updateTimeEntry,
} from "~/domains/time/time.mutations.server";
import { getCapacityOverview } from "~/domains/tasks/tasks.queries.server";
import { listActivity, listRecentActivity } from "~/domains/activity/activity.queries.server";
import { listEntityHistory } from "~/domains/tickets/tickets.history.server";
import { NAV } from "~/components/layout/nav";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerReadTools } from "~/lib/mcp/read-tools.server";

let signedIn: AuthUser;
vi.mock("~/lib/auth.server", async (original) => ({
  ...(await original<typeof import("~/lib/auth.server")>()),
  requireUser: vi.fn(async () => signedIn),
}));
const timesheet = await import("~/routes/_desktop.timesheet/route");
const activity = await import("~/routes/_desktop.activity/route");
const mobile = await import("~/routes/m.timesheet._index/route");
const run = `privacy-${Date.now()}`;
const users: AuthUser[] = [];
let entryId: string;
const interval = { startsAt: new Date("2026-11-10T08:00Z"), endsAt: new Date("2026-11-10T09:00Z") };

beforeAll(async () => {
  for (const role of ["MEMBER", "ADMIN", "MEMBER"] as const) {
    users.push(
      (await db.user.create({
        data: {
          name: `${run}-${users.length}`,
          email: `${run}-${users.length}@example.invalid`,
          role,
        },
      })) as AuthUser,
    );
  }
  entryId = (await createTimeEntry(users[2], interval)).id;
});
afterAll(async () => {
  await db.timeEntry.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.$disconnect();
});

describe("private time by default", () => {
  for (const index of [0, 1]) {
    it(`refuses another person's reads and mutations for ${index ? "an admin" : "a member"}`, async () => {
      const viewer = users[index];
      const target = users[2].id;
      for (const read of [
        () => getRunningEntry(viewer, target),
        () => getTimeEntry(viewer, entryId, target),
        () => listWeekEntries(viewer, target, "2026-W46"),
        () => getWeekTimesheet(viewer, target, "2026-W46"),
        () => createTimeEntry(viewer, { ...interval, userId: target }),
        () => updateTimeEntry(viewer, entryId, interval),
        () => deleteTimeEntry(viewer, entryId),
      ])
        await expect(read()).rejects.toMatchObject({ status: 403 });
      signedIn = viewer;
      await expect(
        timesheet.loader({
          request: new Request(`http://localhost/timesheet?user=${target}`),
        } as never),
      ).rejects.toMatchObject({ status: 403 });
      const own = await timesheet.loader({
        request: new Request("http://localhost/timesheet"),
      } as never);
      expect(own.users).toEqual([]);
      expect(own.targetUserId).toBe(viewer.id);
      const m = await mobile.loader({
        request: new Request(`http://localhost/m/timesheet?user=${target}`),
      } as never);
      expect(m.sheet.entries.every((e) => e.userId === viewer.id)).toBe(true);
      const capacity = await getCapacityOverview(viewer, new Date("2026-11-10T12:00Z"));
      expect(capacity.rows.find((r) => r.userId === target)?.weeks[0].logged).toBeUndefined();
      expect(capacity.rows.some((r) => r.userId === target)).toBe(true);
    });
  }
  it("allows explicit read access, never editing, and revokes immediately", async () => {
    const viewer = users[0],
      target = users[2].id;
    await db.userPermission.create({ data: { userId: viewer.id, permission: "time.viewOthers" } });
    expect((await getWeekTimesheet(viewer, target, "2026-W46")).entries.map((e) => e.id)).toContain(
      entryId,
    );
    expect(
      (await getCapacityOverview(viewer, new Date("2026-11-10T12:00Z"))).rows.find(
        (r) => r.userId === target,
      )?.weeks[0].logged,
    ).toBe(60);
    await expect(updateTimeEntry(viewer, entryId, interval)).rejects.toMatchObject({ status: 403 });
    await db.userPermission.deleteMany({ where: { userId: viewer.id } });
    await expect(getTimeEntry(viewer, entryId, target)).rejects.toMatchObject({ status: 403 });
  });
  it("keeps per-record history and recent activity while guarding the global feed", async () => {
    signedIn = users[0];
    await expect(
      activity.loader({ request: new Request("http://localhost/activity") } as never),
    ).rejects.toMatchObject({ status: 403 });
    await expect(listActivity(users[0])).rejects.toMatchObject({ status: 403 });
    expect((await listActivity(users[1])).items.every((r) => r.entityType !== "timeEntry")).toBe(
      true,
    );
    expect((await listRecentActivity()).items.every((r) => r.entityType !== "timeEntry")).toBe(
      true,
    );
    expect(Array.isArray(await listEntityHistory("task", "synthetic-task"))).toBe(true);
    expect(NAV.find((n) => n.to === "/activity")?.adminOnly).toBe(true);
  });
  it("enforces every MCP time read and the workspace feed against the real database", async () => {
    for (const viewer of users.slice(0, 2)) {
      const server = new McpServer({ name: "privacy", version: "1" });
      registerReadTools(server, {
        user: viewer,
        token: { id: "synthetic", name: "Privacy", scope: "READ_ONLY" },
      });
      const client = new Client({ name: "privacy", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      for (const name of [
        "list_time_entries",
        "get_time_entry",
        "get_timesheet",
        "get_running_timer",
      ]) {
        const res = await client.callTool({
          name,
          arguments: { userId: users[2].id, id: entryId, isoWeek: "2026-W46" },
        });
        expect(res.isError, name).toBe(true);
        expect(JSON.stringify(res.content)).toContain("403");
      }
      if (viewer.role === "MEMBER")
        expect((await client.callTool({ name: "list_activity" })).isError).toBe(true);
      expect((await client.listTools()).tools.some((t) => /permission|grant/.test(t.name))).toBe(
        false,
      );
      await client.close();
      await server.close();
    }
  });
});
