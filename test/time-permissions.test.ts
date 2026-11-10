import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";
import { listUserPermissions, setTimePermission } from "~/domains/auth/permissions.server";
import { listTimeViewers, recordTimesheetView } from "~/domains/time/time-access.server";
import { getWeekTimesheet } from "~/domains/time/time.queries.server";
import {
  createTimeEntry,
  deleteTimeEntry,
  updateTimeEntry,
} from "~/domains/time/time.mutations.server";
import { hasPermission } from "~/lib/rbac.server";
import { listRecentActivity, listActivity } from "~/domains/activity/activity.queries.server";

let signedIn: AuthUser;
vi.mock("~/lib/auth.server", async (original) => ({
  ...(await original<typeof import("~/lib/auth.server")>()),
  requireUser: vi.fn(async () => signedIn),
  requireRole: vi.fn(async () => {
    if (signedIn.role !== "ADMIN") throw new Response("Forbidden", { status: 403 });
    return signedIn;
  }),
}));
const adminPage = await import("~/routes/_desktop.admin.users.$id/route");
const desktop = await import("~/routes/_desktop.timesheet/route");
const mobile = await import("~/routes/m.timesheet._index/route");
const users: AuthUser[] = [];
const run = `grants-${Date.now()}`;
const interval = { startsAt: new Date("2026-10-20T08:00Z"), endsAt: new Date("2026-10-20T09:00Z") };
beforeAll(async () => {
  for (const role of ["ADMIN", "MEMBER", "MEMBER"] as const)
    users.push(
      (await db.user.create({
        data: {
          name: `${run}-${users.length}`,
          email: `${run}-${users.length}@example.invalid`,
          role,
        },
      })) as AuthUser,
    );
});
afterAll(async () => {
  await db.timeEntry.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
  await db.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await db.$disconnect();
});

it("audits each real grant and revoke, permits admin self-grants and refuses members and MCP", async () => {
  const [admin, viewer] = users;
  for (const actor of [
    viewer,
    { ...admin, via: { kind: "mcp" as const, tokenId: "synthetic", tokenName: "Agent" } },
  ]) {
    await expect(
      setTimePermission(actor, viewer.id, "time.viewOthers", true),
    ).rejects.toMatchObject({ status: 403 });
  }
  await expect(listUserPermissions(viewer, admin.id)).rejects.toMatchObject({ status: 403 });
  await expect(setTimePermission(admin, viewer.id, "audit.view", true)).rejects.toThrow();
  for (const target of [admin, viewer]) {
    await setTimePermission(admin, target.id, "time.viewOthers", true);
    await setTimePermission(admin, target.id, "time.viewOthers", true);
    expect(await hasPermission(target, "time.viewOthers")).toBe(true);
    await setTimePermission(admin, target.id, "time.viewOthers", false);
    expect(await hasPermission(target, "time.viewOthers")).toBe(false);
    const logs = await db.activityLog.findMany({
      where: {
        entityId: target.id,
        action: { in: ["UserPermissionGranted", "UserPermissionRevoked"] },
      },
      orderBy: { insertedAt: "asc" },
    });
    expect(logs.map((row) => row.action)).toEqual([
      "UserPermissionGranted",
      "UserPermissionRevoked",
    ]);
    expect(logs.every((row) => row.actorId === admin.id && row.entityType === "user")).toBe(true);
    expect(logs[0].data).toEqual({ permission: "time.viewOthers" });
  }
});

it("lets an explicitly permitted member edit and view, and revokes both immediately", async () => {
  const [admin, viewer, owner] = users;
  await setTimePermission(admin, viewer.id, "time.editOthers", true);
  expect(await hasPermission(viewer, "time.viewOthers")).toBe(true);
  const entry = await createTimeEntry(viewer, { ...interval, userId: owner.id });
  expect((await getWeekTimesheet(viewer, owner.id, "2026-W43")).entries.map((e) => e.id)).toContain(
    entry.id,
  );
  await updateTimeEntry(viewer, entry.id, { ...interval, comment: "Edited with permission" });
  await deleteTimeEntry(viewer, entry.id);
  await setTimePermission(admin, viewer.id, "time.editOthers", false);
  await expect(getWeekTimesheet(viewer, owner.id, "2026-W43")).rejects.toMatchObject({
    status: 403,
  });
  await expect(createTimeEntry(viewer, { ...interval, userId: owner.id })).rejects.toMatchObject({
    status: 403,
  });
});

it("names active viewers on both own timesheets, excludes self and removes revoked access", async () => {
  const [admin, viewer, owner] = users;
  expect(await listTimeViewers(owner)).toEqual([]);
  await setTimePermission(admin, viewer.id, "time.editOthers", true);
  expect(await listTimeViewers(owner)).toEqual([{ id: viewer.id, name: viewer.name }]);
  expect(await listTimeViewers(viewer)).toEqual([]);
  signedIn = owner;
  for (const route of [desktop, mobile])
    expect(
      (await route.loader({ request: new Request("http://localhost/timesheet") } as never)).viewers,
    ).toEqual([{ id: viewer.id, name: viewer.name }]);
  await db.user.update({ where: { id: viewer.id }, data: { isActive: false } });
  expect(await listTimeViewers(owner)).toEqual([]);
  await db.user.update({ where: { id: viewer.id }, data: { isActive: true } });
  await setTimePermission(admin, viewer.id, "time.editOthers", false);
  expect(await listTimeViewers(owner)).toEqual([]);
});

it("records at most one view per viewer/person/Berlin day, including concurrent requests", async () => {
  const [admin, viewer, owner] = users;
  const day = new Date("2026-10-24T22:30Z");
  await expect(recordTimesheetView(viewer, owner.id, day)).rejects.toMatchObject({ status: 403 });
  await setTimePermission(admin, viewer.id, "time.viewOthers", true);
  await expect(recordTimesheetView(viewer, "missing-person", day)).rejects.toMatchObject({
    name: "NotFoundError",
  });
  await Promise.all(Array.from({ length: 6 }, () => recordTimesheetView(viewer, owner.id, day)));
  await recordTimesheetView(viewer, owner.id, new Date("2026-10-25T22:30Z"));
  await recordTimesheetView(viewer, owner.id, new Date("2026-10-25T23:30Z"));
  await recordTimesheetView(viewer, viewer.id, day);
  const logs = await db.activityLog.findMany({
    where: {
      action: "TimesheetViewed",
      actorId: viewer.id,
      occurredAt: { gte: new Date("2026-10-24"), lt: new Date("2026-10-27") },
    },
  });
  expect(logs).toHaveLength(2);
  expect(logs.every((row) => row.entityId === owner.id)).toBe(true);
  expect(
    (await listRecentActivity()).items.some((row) =>
      ["TimesheetViewed", "UserPermissionGranted", "UserPermissionRevoked"].includes(row.action),
    ),
  ).toBe(false);
  expect(
    (await listActivity(admin, { actorId: viewer.id, entityTypes: ["user"] })).items.some(
      (row) => row.action === "TimesheetViewed",
    ),
  ).toBe(true);
  await setTimePermission(admin, viewer.id, "time.viewOthers", false);
});

it("grants and revokes through the named user's admin page, including the admin themselves", async () => {
  const [admin] = users;
  signedIn = admin;
  for (const enabled of [true, false]) {
    const response = await adminPage.action({
      params: { id: admin.id },
      request: new Request(`http://localhost/admin/users/${admin.id}`, {
        method: "POST",
        body: new URLSearchParams({
          intent: "timePermission",
          permission: "time.viewOthers",
          enabled: String(enabled),
        }),
      }),
    } as never);
    expect(response).toMatchObject({ permissionSaved: true });
    const data = await adminPage.loader({
      params: { id: admin.id },
      request: new Request("http://localhost/admin/users"),
    } as never);
    expect(data.permissions.some((row) => row.permission === "time.viewOthers")).toBe(enabled);
  }
});
