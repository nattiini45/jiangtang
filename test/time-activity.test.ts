import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { listActivity } from "~/domains/activity/activity.queries.server";
import { listEntityHistory } from "~/domains/tickets/tickets.history.server";
import { setTimePermission } from "~/domains/auth/permissions.server";
import { recordTimesheetView } from "~/domains/time/time-access.server";
import { registerReadTools } from "~/lib/mcp/read-tools.server";
import type { User } from "~/generated/prisma/client";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

const run = `time-activity-${Date.now()}`;
const users: User[] = [];
const deletedId = `${run}-deleted`,
  currentId = `${run}-current`;
const time = new Date("2090-01-01T12:00Z");
const ids: string[] = [];
let legacyId: string;
beforeAll(async () => {
  for (const name of ["owner", "ungranted", "reader"])
    users.push(
      await db.user.create({
        data: { name, email: `${run}-${name}@example.invalid`, role: "ADMIN" },
      }),
    );
  const [owner, ungranted, reader] = users;
  await db.timeEntry.create({ data: { id: currentId, userId: owner.id, startsAt: time } });
  for (const action of [
    "TimeEntryCreated",
    "TimeEntryUpdated",
    "TimeEntryDeleted",
    "TimeEntryStarted",
    "TimeEntryStopped",
  ]) {
    ids.push(
      (
        await db.activityLog.create({
          data: {
            action,
            entityType: "timeEntry",
            entityId: deletedId,
            actorId: ungranted.id,
            occurredAt: time,
            data: {
              ...(action === "TimeEntryStarted" || action === "TimeEntryStopped"
                ? {}
                : { userId: owner.id }),
              comment: "Synthetic private content",
            },
          },
        })
      ).id,
    );
  }
  ids.push(
    (
      await db.activityLog.create({
        data: {
          action: "DemoTimeEntrySeeded",
          entityType: "timeEntry",
          entityId: currentId,
          actorId: ungranted.id,
          occurredAt: time,
        },
      })
    ).id,
  );
  legacyId = (
    await db.activityLog.create({
      data: {
        action: "TimeEntryStarted",
        entityType: "TimeEntry",
        entityId: currentId,
        actorId: ungranted.id,
        occurredAt: time,
      },
    })
  ).id;
  await setTimePermission(owner, reader.id, "time.viewOthers", true);
  await setTimePermission(owner, reader.id, "time.editOthers", true);
  await setTimePermission(owner, reader.id, "time.editOthers", false);
  await recordTimesheetView(reader, owner.id, time);
});
afterAll(async () => {
  await db.timeEntry.deleteMany({ where: { userId: { in: users.map((user) => user.id) } } });
  await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await db.$disconnect();
});

it("filters global, filtered, per-entry and MCP activity by owner or explicit view permission", async () => {
  const [owner, ungranted, reader] = users;
  for (const viewer of users) {
    const expected = viewer.id === ungranted.id ? [] : ids;
    for (const entityTypes of [undefined, ["timeEntry"]]) {
      const result = await listActivity(viewer, { actorId: ungranted.id, entityTypes, limit: 100 });
      expect(result.items.map((row) => row.id).sort()).toEqual(
        [...expected, ...(!entityTypes && expected.length ? [legacyId] : [])].sort(),
      );
      expect(result.nextCursor).toBeNull();
    }
    for (const entryId of [deletedId, currentId]) {
      const history = await listEntityHistory("timeEntry", entryId, 50, viewer);
      expect(history.length).toBe(viewer.id === ungranted.id ? 0 : entryId === currentId ? 1 : 5);
    }
    expect(await listEntityHistory("TimeEntry", currentId, 50, viewer)).toHaveLength(
      viewer.id === ungranted.id ? 0 : 1,
    );
    const grants = await listActivity(viewer, { actorId: owner.id, entityTypes: ["user"] });
    expect(grants.items.map((row) => row.action)).toContain("UserPermissionGranted");
    expect(grants.items.map((row) => row.action)).toContain("UserPermissionRevoked");
    expect(
      (await listActivity(viewer, { actorId: reader.id, entityTypes: ["user"] })).items.some(
        (row) => row.action === "TimesheetViewed",
      ),
    ).toBe(true);
    const server = new McpServer({ name: "time-activity", version: "1" });
    registerReadTools(server, {
      user: viewer,
      token: { id: "synthetic", name: "Read", scope: "READ_ONLY" },
    });
    const client = new Client({ name: "time-activity", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const response = await client.callTool({
      name: "list_activity",
      arguments: { actorId: ungranted.id, entityTypes: ["timeEntry"], limit: 100 },
    });
    expect(response.isError).not.toBe(true);
    const result = (
      response.structuredContent as {
        result: { items: { id: string }[]; nextCursor: string | null };
      }
    ).result;
    expect(result.items.map((row) => row.id).sort()).toEqual([...expected].sort());
    expect(result.nextCursor).toBeNull();
    const accountability = await client.callTool({
      name: "list_activity",
      arguments: { actorId: owner.id, entityTypes: ["user"] },
    });
    expect(accountability.isError).not.toBe(true);
    expect(JSON.stringify(accountability.structuredContent)).toContain("UserPermissionRevoked");
    await client.close();
    await server.close();
  }
  expect(await listEntityHistory("timeEntry", deletedId)).toEqual([]);
  await db.user.update({ where: { id: owner.id }, data: { role: "MEMBER" } });
  expect(await listEntityHistory("timeEntry", deletedId, 50, owner)).toHaveLength(5);
  await expect(listActivity(owner)).rejects.toMatchObject({ status: 403 });
});
