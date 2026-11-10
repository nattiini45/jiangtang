import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { db } from "~/lib/db.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { registerWorkWrites } from "~/lib/mcp/work-writes.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";

vi.mock("~/lib/realtime/emit.server", () => ({ emitChange: vi.fn() }));

const prefix = `mcp-work-${crypto.randomUUID()}`;
let member: McpContext;
let admin: McpContext;
const users: string[] = [];
const taskIds: string[] = [];
const projectIds: string[] = [];
const noteIds: string[] = [];
const sessions: Array<{ client: Client; server: McpServer }> = [];
const instantInput = {
  startsAt: "2026-07-01T10:00:00+02:00",
  endsAt: "2026-07-01T11:00:00+02:00",
};

async function connect(context = member) {
  const server = new McpServer({ name: "work-writes-test", version: "1" });
  registerWorkWrites(server, context);
  const client = new Client({ name: "work-writes-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  sessions.push({ server, client });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return client.callTool({ name, arguments: args });
}

async function success(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await call(client, name, args);
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return (result.structuredContent as { result: Record<string, unknown> }).result;
}

function expectStatus(result: Awaited<ReturnType<typeof call>>, status: number) {
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining(`"status":${status}`) }),
  ]);
}

function expectSchemaError(result: Awaited<ReturnType<typeof call>>) {
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("Input validation error") }),
  ]);
}

async function task(client: Client, input: Record<string, unknown> = {}) {
  const result = await success(client, "create_task", { input: { title: prefix, ...input } });
  taskIds.push(result.id as string);
  return result.id as string;
}

async function project(client: Client, input: Record<string, unknown> = {}) {
  const result = await success(client, "create_project", { input: { name: prefix, ...input } });
  projectIds.push(result.id as string);
  return result.id as string;
}

async function note(client: Client) {
  const result = await success(client, "create_note", { input: { title: prefix, body: "First" } });
  noteIds.push(result.id as string);
  return result.id as string;
}

beforeAll(async () => {
  for (const role of ["MEMBER", "ADMIN"] as const) {
    const user = await db.user.create({
      data: { name: `${prefix}-${role}`, email: `${prefix}-${role}@example.test`, role },
    });
    users.push(user.id);
    const context: McpContext = {
      user: { id: user.id, name: user.name, email: user.email, initials: null, role },
      token: { id: `${prefix}-token`, name: "Synthetic work writer", scope: "READ_WRITE" },
    };
    if (role === "MEMBER") member = context;
    else admin = context;
  }
});

beforeEach(() => {
  vi.mocked(emitChange).mockReset();
});

afterEach(async () => {
  for (const { client, server } of sessions.splice(0)) {
    await client.close();
    await server.close();
  }
  await db.timeEntry.deleteMany({ where: { userId: { in: users } } });
});

afterAll(async () => {
  await db.notification.deleteMany({ where: { userId: { in: users } } });
  await db.note.deleteMany({ where: { id: { in: noteIds } } });
  await db.task.updateMany({ where: { id: { in: taskIds } }, data: { parentTaskId: null } });
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
  await db.project.updateMany({
    where: { id: { in: projectIds } },
    data: { parentProjectId: null },
  });
  await db.project.deleteMany({ where: { id: { in: projectIds } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
});

describe("MCP work writes", () => {
  it("publishes concrete JSON schemas and write/destructive annotations for the entire catalog", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "create_task",
        "update_task",
        "set_task_status",
        "move_task",
        "set_task_assignees",
        "add_task_blocker",
        "remove_task_blocker",
        "delete_task",
        "create_project",
        "update_project",
        "set_project_status",
        "delete_project",
        "create_note",
        "update_note",
        "set_note_pinned",
        "archive_note",
        "unarchive_note",
        "delete_note",
        "start_timer",
        "stop_timer",
        "create_time_entry",
        "update_time_entry",
        "delete_time_entry",
        "mark_notification_read",
        "mark_all_notifications_read",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(false);
      if (tool.annotations?.destructiveHint) {
        expect(tool.inputSchema.required).toContain("confirm");
        expect(tool.inputSchema.properties?.confirm).toMatchObject({ const: true });
      }
    }
    expect(
      tools.find((tool) => tool.name === "update_note")?.inputSchema.properties?.input,
    ).toMatchObject({ required: expect.arrayContaining(["title", "version"]) });
    expect(
      tools.find((tool) => tool.name === "create_time_entry")?.inputSchema.properties?.input,
    ).toMatchObject({ properties: { startsAt: { type: "string", format: "date-time" } } });
    for (const [name, fragments] of [
      [
        "stop_timer",
        [
          "strictly after its start time",
          "server's current time",
          "refused without changes",
          "update_time_entry",
          "wait until after the start time",
        ],
      ],
      [
        "create_time_entry",
        [
          "ISO instants with offsets",
          "at or before the server's mutation-time now",
          "Use start_timer to start your own timer at server time",
          "endsAt after startsAt",
          "may be in the future",
          "only admins may choose userId",
        ],
      ],
      [
        "update_time_entry",
        [
          "ISO instants with offsets",
          "Changed running results (endsAt: null)",
          "at or before the server's mutation-time now",
          "identical updates remain unaudited no-write no-ops",
          "including existing future-running entries",
          "endsAt after startsAt",
          "may be in the future",
          "Use start_timer to start your own timer at server time",
          "Members edit only their own entries; admins may edit others",
          "Ownership cannot be reassigned",
        ],
      ],
    ] as const) {
      const description = tools.find((tool) => tool.name === name)?.description;
      for (const fragment of fragments) expect(description).toContain(fragment);
    }
  });

  it("refuses read-only tokens before writes and allows ordinary members to create work", async () => {
    const client = await connect({ ...member, token: { ...member.token, scope: "READ_ONLY" } });
    expectStatus(await call(client, "create_task", { input: { title: prefix } }), 403);
    expectStatus(await call(client, "create_note", { input: { title: prefix } }), 403);
    expectStatus(await call(client, "create_project", { input: { name: prefix } }), 403);
    expectStatus(await call(client, "start_timer"), 403);
    expectStatus(await call(client, "mark_all_notifications_read"), 403);
    expect(emitChange).not.toHaveBeenCalled();
    expect(await db.task.count({ where: { title: prefix } })).toBe(0);
    await task(await connect());
  });

  it("creates subtasks, replaces content, refuses hierarchy cycles and audits the MCP actor", async () => {
    const client = await connect();
    const parent = await task(client);
    const child = await task(client, { parentTaskId: parent, dueAt: "2026-07-01" });
    expect(await db.task.findUniqueOrThrow({ where: { id: child } })).toMatchObject({
      parentTaskId: parent,
      dueAt: new Date("2026-06-30T22:00:00Z"),
    });
    const updated = await success(client, "update_task", {
      id: child,
      input: { title: "Renamed", parentTaskId: parent },
    });
    expect(updated.title).toBe("Renamed");
    expectStatus(
      await call(client, "update_task", {
        id: parent,
        input: { title: prefix, parentTaskId: child },
      }),
      422,
    );
    const row = await db.activityLog.findFirstOrThrow({
      where: { entityId: child, action: "TaskCreated" },
    });
    expect(row.actorId).toBe(member.user.id);
    expect(row.actorSnapshot).toMatchObject({
      via: "via MCP (Synthetic work writer)",
      tokenId: member.token.id,
    });
  });

  it("uses domain lane transitions, fractional ordering and per-assignee estimates", async () => {
    const client = await connect();
    const first = await task(client);
    const last = await task(client);
    const middle = await task(client);
    await success(client, "set_task_status", { id: first, status: "IN_PROGRESS" });
    await success(client, "set_task_status", { id: last, status: "IN_PROGRESS" });
    await success(client, "move_task", {
      id: middle,
      lane: "IN_PROGRESS",
      afterId: first,
      beforeId: last,
    });
    const rows = await db.task.findMany({
      where: { id: { in: [first, last, middle] } },
      orderBy: { position: "asc" },
    });
    expect(rows.map((row) => row.id)).toEqual([first, middle, last]);
    expect(rows[1].status).toBe("IN_PROGRESS");
    await success(client, "set_task_assignees", {
      id: middle,
      assignees: [
        { userId: member.user.id, estimateMinutes: 42 },
        { userId: admin.user.id, estimateMinutes: 15 },
      ],
    });
    expect(
      await db.taskAssignees.findUniqueOrThrow({
        where: { taskId_userId: { taskId: middle, userId: member.user.id } },
      }),
    ).toMatchObject({ estimateMinutes: 42 });
    await success(client, "set_task_assignees", {
      id: middle,
      assignees: [{ userId: member.user.id, estimateMinutes: 90 }],
    });
    expect(await db.taskAssignees.count({ where: { taskId: middle } })).toBe(1);
    expect(
      await db.taskAssignees.findUniqueOrThrow({
        where: { taskId_userId: { taskId: middle, userId: member.user.id } },
      }),
    ).toMatchObject({ estimateMinutes: 90 });
  });

  it("adds and removes dependencies without bypassing DAG or confirmation checks", async () => {
    const client = await connect();
    const a = await task(client);
    const b = await task(client);
    await success(client, "add_task_blocker", { taskId: a, blockerTaskId: b });
    expectStatus(await call(client, "add_task_blocker", { taskId: b, blockerTaskId: a }), 422);
    expectStatus(await call(client, "add_task_blocker", { taskId: a, blockerTaskId: a }), 422);
    expect(
      (await call(client, "remove_task_blocker", { taskId: a, blockerTaskId: b })).isError,
    ).toBe(true);
    expect(await db.taskDependency.count({ where: { blockedByTaskId: a } })).toBe(1);
    await success(client, "remove_task_blocker", { taskId: a, blockerTaskId: b, confirm: true });
    expect(await db.taskDependency.count({ where: { blockedByTaskId: a } })).toBe(0);
  });

  it("creates, replaces and transitions projects with the existing hierarchy deletion guard", async () => {
    const client = await connect();
    const parent = await project(client);
    const child = await project(client, { parentProjectId: parent });
    await success(client, "update_project", {
      id: child,
      input: { name: "Synthetic project", parentProjectId: parent },
    });
    const result = await success(client, "set_project_status", { id: child, status: "CONFIRMED" });
    expect(result.name).toBe("Synthetic project");
    expect(result.status).toBe("CONFIRMED");
    expectStatus(await call(client, "delete_project", { id: parent, confirm: true }), 422);
    await success(client, "delete_project", { id: child, confirm: true });
    await success(client, "delete_project", { id: parent, confirm: true });
  });

  it("requires explicit true confirmation for every destructive tool", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools.filter((tool) => tool.annotations?.destructiveHint)) {
      for (const confirm of [undefined, false, "true"]) {
        const result = await call(client, tool.name, {
          id: "missing",
          taskId: "missing",
          blockerTaskId: "missing",
          ...(confirm === undefined ? {} : { confirm }),
        });
        expect(result.isError).toBe(true);
      }
    }
    expect(emitChange).not.toHaveBeenCalled();
  });

  it("honors optimistic note versions, pinning and archive lifecycle", async () => {
    const client = await connect();
    const id = await note(client);
    const updated = await success(client, "update_note", {
      id,
      input: { title: prefix, body: "Second", version: 1 },
    });
    expect(updated.version).toBe(2);
    vi.mocked(emitChange).mockClear();
    expectStatus(
      await call(client, "update_note", {
        id,
        input: { title: prefix, body: "Stale", version: 1 },
      }),
      409,
    );
    expectSchemaError(
      await call(client, "update_note", {
        id,
        input: { title: prefix, body: "Invalid", version: 0 },
      }),
    );
    expect(emitChange).not.toHaveBeenCalled();
    expect((await db.note.findUniqueOrThrow({ where: { id } })).body).toBe("Second");
    expect(await success(client, "set_note_pinned", { id, pinned: true })).toMatchObject({
      pinned: true,
    });
    await success(client, "archive_note", { id, confirm: true });
    expect((await db.note.findUniqueOrThrow({ where: { id } })).archivedAt).not.toBeNull();
    await success(client, "unarchive_note", { id });
    expect((await db.note.findUniqueOrThrow({ where: { id } })).archivedAt).toBeNull();
    await success(client, "delete_note", { id, confirm: true });
    expect(await db.note.findUnique({ where: { id } })).toBeNull();
  });

  it("rejects naive instants before domain transforms and accepts offset instants and task days", async () => {
    const client = await connect();
    for (const value of ["2026-07-01T10:00", "2026-07-01 10:00", "July 1, 2026"]) {
      expectSchemaError(
        await call(client, "create_task", { input: { title: prefix, dueAt: value } }),
      );
      expectSchemaError(
        await call(client, "create_project", { input: { name: prefix, startAt: value } }),
      );
      expectSchemaError(
        await call(client, "create_time_entry", { input: { ...instantInput, startsAt: value } }),
      );
    }
    expectSchemaError(
      await call(client, "create_project", { input: { name: prefix, startAt: "2026-07-01" } }),
    );
    const id = await task(client, { startAt: "2026-07-01T10:00:00+02:00", dueAt: "2026-07-02" });
    expect((await db.task.findUniqueOrThrow({ where: { id } })).startAt).toEqual(
      new Date("2026-07-01T08:00:00Z"),
    );
    expectStatus(
      await call(client, "create_time_entry", {
        input: { ...instantInput, endsAt: "2026-07-01T09:00:00+02:00" },
      }),
      422,
    );
  });

  it("preserves member time ownership while retaining admin authorization through mcpActor", async () => {
    const client = await connect();
    const adminClient = await connect(admin);
    const own = await success(client, "create_time_entry", {
      input: { ...instantInput, userId: admin.user.id },
    });
    expect(own.userId).toBe(member.user.id);
    const other = await success(adminClient, "create_time_entry", {
      input: { ...instantInput, userId: admin.user.id },
    });
    const filed = await success(adminClient, "create_time_entry", {
      input: { ...instantInput, userId: member.user.id },
    });
    expect(filed.userId).toBe(member.user.id);
    expectStatus(
      await call(client, "update_time_entry", {
        id: other.id,
        input: { ...instantInput, comment: "Refused" },
      }),
      422,
    );
    expectStatus(await call(client, "delete_time_entry", { id: other.id, confirm: true }), 422);
    await success(adminClient, "update_time_entry", {
      id: own.id,
      input: { ...instantInput, comment: "Admin edit" },
    });
    expect(
      (await db.timeEntry.findUniqueOrThrow({ where: { id: own.id as string } })).comment,
    ).toBe("Admin edit");
    await success(adminClient, "delete_time_entry", { id: own.id, confirm: true });
    await success(client, "delete_time_entry", { id: filed.id, confirm: true });
  });

  it("starts and stops only the signed-in user's timer and respects the one-running constraint", async () => {
    const client = await connect();
    const adminClient = await connect(admin);
    const id = await task(client);
    const first = await success(client, "start_timer", { taskId: id });
    const second = await success(adminClient, "start_timer");
    expect(first.userId).toBe(member.user.id);
    expect(second.userId).toBe(admin.user.id);
    expectStatus(await call(client, "start_timer"), 422);
    expectStatus(
      await call(client, "create_time_entry", { input: { ...instantInput, endsAt: null } }),
      422,
    );
    expect((await success(client, "stop_timer")).id).toBe(first.id);
    expect(
      (await db.timeEntry.findUniqueOrThrow({ where: { id: second.id as string } })).endsAt,
    ).toBeNull();
    expectStatus(await call(client, "stop_timer"), 422);
    await success(adminClient, "stop_timer");
  });

  it.each(["en", "de"] as const)(
    "%s: future running create/edit/Stop use canonical recoverable errors without writes",
    async (locale) => {
      const client = await connect();
      const future = new Date(Date.now() + 3_600_000);
      const input = { startsAt: future.toISOString(), endsAt: null };
      const entry = await db.timeEntry.create({
        data: { userId: member.user.id, startsAt: future },
      });
      const snapshot = async () => ({
        entry: await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } }),
        count: await db.timeEntry.count({ where: { userId: member.user.id } }),
        audits: await db.activityLog.findMany({
          where: { actorId: member.user.id },
          orderBy: { id: "asc" },
        }),
      });
      const before = await snapshot();
      await runWithLocale(locale, async () => {
        for (const [name, args, key] of [
          ["create_time_entry", { input }, "work.err.time.futureRunning"],
          [
            "update_time_entry",
            { id: entry.id, input: { ...input, comment: "Changed" } },
            "work.err.time.futureRunning",
          ],
          ["stop_timer", {}, "work.err.time.futureTimerStop"],
        ] as const) {
          const result = await call(client, name, args);
          expect(result.isError).toBe(true);
          expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
          const content = result.content as Array<{ type: "text"; text: string }>;
          expect(JSON.parse(content[0].text)).toEqual({
            status: 422,
            detail: {
              error: "ValidationError",
              message: t(locale, "err.validationFailed"),
              fieldErrors: { startsAt: [t(locale, key)] },
              formErrors: [t(locale, key)],
            },
          });
          expect(await snapshot()).toEqual(before);
          expect(emitChange).not.toHaveBeenCalled();
        }
      });
      await success(client, "update_time_entry", {
        id: entry.id,
        input: { startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: null },
      });
      await success(client, "stop_timer");
      const stopped = await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(stopped.endsAt).not.toBeNull();
      const logs = await db.activityLog.findMany({ where: { entityId: entry.id } });
      expect(logs.map((log) => log.action).sort()).toEqual([
        "TimeEntryStopped",
        "TimeEntryUpdated",
      ]);
      expect(logs.every((log) => log.actorId === member.user.id)).toBe(true);
      expect(
        logs.every(
          (log) => (log.actorSnapshot as { via: string }).via === "via MCP (Synthetic work writer)",
        ),
      ).toBe(true);
      expect(emitChange).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["en", "de"] as const)(
    "%s: exact-now Stop returns canonical validation without writes, and +1ms succeeds",
    async (locale) => {
      const client = await connect();
      const now = new Date("2026-11-09T12:00:00Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(now);
      try {
        await runWithLocale(locale, async () => {
          const entry = await success(client, "start_timer");
          vi.mocked(emitChange).mockClear();
          const snapshot = async () => ({
            entry: await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id as string } }),
            audits: await db.activityLog.findMany({ where: { entityId: entry.id as string } }),
          });
          const before = await snapshot();
          const result = await call(client, "stop_timer");
          expect(await snapshot()).toEqual(before);
          expect(emitChange).not.toHaveBeenCalled();
          expect(result.isError).toBe(true);
          const content = result.content as Array<{ type: "text"; text: string }>;
          expect(JSON.parse(content[0].text)).toEqual({
            status: 422,
            detail: {
              error: "ValidationError",
              message: t(locale, "err.validationFailed"),
              fieldErrors: { startsAt: [t(locale, "work.err.time.futureTimerStop")] },
              formErrors: [t(locale, "work.err.time.futureTimerStop")],
            },
          });
          const endsAt = new Date(now.getTime() + 1);
          vi.setSystemTime(endsAt);
          await success(client, "stop_timer");
          const after = await snapshot();
          expect(after.entry).toMatchObject({ startsAt: now, endsAt });
          expect(after.audits).toHaveLength(2);
          expect(after.audits.find((log) => log.action === "TimeEntryStopped")?.data).toMatchObject(
            { minutes: 0 },
          );
          expect(emitChange).toHaveBeenCalledExactlyOnceWith({
            entityType: "timeEntry",
            id: entry.id,
            op: "updated",
          });
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("limits notification writes to the actor's inbox even for admins", async () => {
    const client = await connect();
    const adminClient = await connect(admin);
    const own = await db.notification.create({
      data: { userId: member.user.id, type: "TASK_ASSIGNED" },
    });
    const other = await db.notification.create({
      data: { userId: admin.user.id, type: "TASK_ASSIGNED" },
    });
    expectStatus(await call(adminClient, "mark_notification_read", { id: own.id }), 404);
    expectStatus(await call(client, "mark_notification_read", { id: other.id }), 404);
    await success(client, "mark_notification_read", { id: own.id });
    expect(
      (await db.notification.findUniqueOrThrow({ where: { id: own.id } })).readAt,
    ).not.toBeNull();
    const ownUnread = await db.notification.count({
      where: { userId: member.user.id, readAt: null },
    });
    expect(await success(client, "mark_all_notifications_read")).toMatchObject({
      count: ownUnread,
    });
    expect(
      (await db.notification.findUniqueOrThrow({ where: { id: other.id } })).readAt,
    ).toBeNull();
  });

  it("emits only after domain writes and their audit rows have committed", async () => {
    const client = await connect();
    const committed: string[] = [];
    vi.mocked(emitChange).mockImplementation(async ({ entityType, id, op }) => {
      expect(entityType).toBe("task");
      const row = await db.task.findUnique({ where: { id } });
      if (op === "deleted") expect(row).toBeNull();
      else expect(row).not.toBeNull();
      const action =
        op === "created" ? "TaskCreated" : op === "deleted" ? "TaskDeleted" : "TaskUpdated";
      expect(await db.activityLog.count({ where: { entityId: id, action } })).toBe(1);
      committed.push(action);
    });
    const id = await task(client);
    await success(client, "update_task", { id, input: { title: "Committed replacement" } });
    await success(client, "delete_task", { id, confirm: true });
    expect(committed).toEqual(["TaskCreated", "TaskUpdated", "TaskDeleted"]);
    vi.mocked(emitChange).mockClear();
    expectStatus(
      await call(client, "update_task", { id, input: { title: "No longer exists" } }),
      404,
    );
    expect(emitChange).not.toHaveBeenCalled();
  });
});
