import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
import { db } from "~/lib/db.server";
import { NotFoundError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import {
  markAllNotificationsRead,
  markNotificationRead,
  notifyUsers,
} from "../notifications.mutations.server";

vi.mock("~/lib/realtime/emit.server", () => ({ emitChange: vi.fn() }));

let owner: { id: string; name: string };
let other: { id: string; name: string };
const firstReadAt = new Date("2026-01-02T03:04:05.678Z");

beforeEach(async () => {
  vi.mocked(emitChange).mockReset();
  const run = crypto.randomUUID();
  owner = await db.user.create({
    data: { email: `${run}-owner@jiangtang.test`, name: "Notification owner" },
  });
  other = await db.user.create({
    data: { email: `${run}-other@jiangtang.test`, name: "Other notification owner" },
  });
});

afterEach(async () => {
  const userIds = [owner.id, other.id];
  try {
    expect(await db.activityLog.count({ where: { actorId: { in: userIds } } })).toBe(0);
  } finally {
    await db.notification.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  }
});

afterAll(async () => {
  await db.$disconnect();
});

async function waitForBlockedWrites(client: Client, count: number) {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    await client.query("SELECT pg_stat_clear_snapshot()");
    const result = await client.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND cardinality(pg_blocking_pids(pid)) > 0
        AND query LIKE '%"Notification"%'
    `);
    if (result.rows[0].count === count) return;
    await setTimeout(10);
  }
  throw new Error(`Expected ${count} blocked notification writes`);
}

describe("notification read contract", () => {
  it("marks an unread notification and returns the complete committed row before emitting", async () => {
    const row = await db.notification.create({
      data: {
        userId: owner.id,
        type: "TASK_ASSIGNED",
        entityType: "task",
        entityId: "synthetic-task",
        data: { title: "Synthetic assignment" },
      },
    });
    vi.mocked(emitChange).mockImplementation(async () => {
      expect(await db.notification.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
        ...row,
        readAt: expect.any(Date),
      });
    });

    const result = await markNotificationRead(owner, row.id);

    expect(result).toEqual({ ...row, readAt: expect.any(Date) });
    expect(await db.notification.findUniqueOrThrow({ where: { id: row.id } })).toEqual(result);
    expect(emitChange).toHaveBeenCalledExactlyOnceWith({
      entityType: "notification",
      id: row.id,
      op: "updated",
    });
  });

  it("returns the same NotFound error for foreign and missing ids without writing or emitting", async () => {
    const row = await db.notification.create({
      data: { userId: other.id, type: "TASK_ASSIGNED" },
    });
    const foreign = await markNotificationRead(owner, row.id).catch((error: unknown) => error);
    const missing = await markNotificationRead(owner, crypto.randomUUID()).catch(
      (error: unknown) => error,
    );

    expect(foreign).toBeInstanceOf(NotFoundError);
    expect(missing).toEqual(foreign);
    expect(await db.notification.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(emitChange).not.toHaveBeenCalled();
  });

  it("does not grant ownership to an actor without an id", async () => {
    const row = await db.notification.create({
      data: { userId: owner.id, type: "TASK_ASSIGNED" },
    });

    await expect(markNotificationRead({}, row.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await markAllNotificationsRead({})).toBe(0);
    expect(await db.notification.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(emitChange).not.toHaveBeenCalled();
  });

  it("marks only the owner's unread rows, preserves earlier reads, and emits only for a positive count", async () => {
    const unread = await db.notification.create({
      data: { userId: owner.id, type: "TASK_ASSIGNED" },
    });
    const second = await db.notification.create({
      data: { userId: owner.id, type: "TASK_DUE_SOON" },
    });
    const read = await db.notification.create({
      data: { userId: owner.id, type: "TASK_ASSIGNED", readAt: firstReadAt },
    });
    const foreign = await db.notification.create({
      data: { userId: other.id, type: "TASK_ASSIGNED" },
    });
    vi.mocked(emitChange).mockImplementation(async () => {
      expect(await db.notification.count({ where: { userId: owner.id, readAt: null } })).toBe(0);
    });

    expect(await markAllNotificationsRead(owner)).toBe(2);
    const rows = await db.notification.findMany({ where: { userId: owner.id } });
    expect(rows).toEqual(
      expect.arrayContaining([
        { ...unread, readAt: expect.any(Date) },
        { ...second, readAt: expect.any(Date) },
        read,
      ]),
    );
    expect(await db.notification.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(foreign);
    expect(await markAllNotificationsRead(owner)).toBe(0);
    expect(await db.notification.findMany({ where: { userId: owner.id } })).toEqual(rows);
    expect(emitChange).toHaveBeenCalledExactlyOnceWith({
      entityType: "notification",
      id: owner.id,
      op: "updated",
    });
  });

  it("continues emitting a notification update on repeated mark-one calls", async () => {
    const row = await db.notification.create({
      data: { userId: owner.id, type: "TASK_ASSIGNED" },
    });

    await markNotificationRead(owner, row.id);
    await markNotificationRead(owner, row.id);

    expect(emitChange).toHaveBeenCalledTimes(2);
    expect(vi.mocked(emitChange).mock.calls).toEqual([
      [{ entityType: "notification", id: row.id, op: "updated" }],
      [{ entityType: "notification", id: row.id, op: "updated" }],
    ]);
  });

  it("preserves a preexisting first read timestamp on every repeated mark-one call", async () => {
    const row = await db.notification.create({
      data: { userId: owner.id, type: "TASK_ASSIGNED", readAt: firstReadAt },
    });

    expect(await markNotificationRead(owner, row.id)).toEqual(row);
    expect(await markNotificationRead(owner, row.id)).toEqual(row);
    expect(await db.notification.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(emitChange).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["mark-one", "mark-one"],
    ["mark-all", "mark-one"],
    ["mark-one", "mark-all"],
  ] as const)(
    "preserves the first timestamp when %s precedes concurrent %s",
    async (first, second) => {
      const row = await db.notification.create({
        data: { userId: owner.id, type: "TASK_ASSIGNED" },
      });
      const blocker = new Client({ connectionString: process.env.DATABASE_URL });
      await blocker.connect();
      const pending: Promise<unknown>[] = [];
      const mark = (kind: "mark-one" | "mark-all") =>
        kind === "mark-one" ? markNotificationRead(owner, row.id) : markAllNotificationsRead(owner);
      try {
        await blocker.query("BEGIN");
        await blocker.query('SELECT id FROM "Notification" WHERE id = $1 FOR UPDATE', [row.id]);
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(firstReadAt);
        pending.push(mark(first));
        await waitForBlockedWrites(blocker, 1);
        vi.setSystemTime(new Date("2026-01-02T04:05:06.789Z"));
        pending.push(mark(second));
        await waitForBlockedWrites(blocker, 2);
        await blocker.query("ROLLBACK");

        const [firstResult, secondResult] = await Promise.all(pending);

        expect(firstResult).toEqual(first === "mark-all" ? 1 : { ...row, readAt: firstReadAt });
        expect(secondResult).toEqual(second === "mark-all" ? 0 : { ...row, readAt: firstReadAt });
        expect(await db.notification.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
          ...row,
          readAt: firstReadAt,
        });
        expect(emitChange).toHaveBeenCalledTimes(second === "mark-all" ? 1 : 2);
      } finally {
        vi.useRealTimers();
        await blocker.query("ROLLBACK");
        await Promise.allSettled(pending);
        await blocker.end();
      }
    },
  );

  it("creates notifications without audit rows and emits each committed row, with an empty-input no-op", async () => {
    vi.mocked(emitChange).mockImplementation(async ({ id }) => {
      expect(await db.notification.findUniqueOrThrow({ where: { id } })).toMatchObject({
        userId: owner.id,
        readAt: null,
      });
    });

    expect(await notifyUsers(owner, [])).toBe(0);
    expect(emitChange).not.toHaveBeenCalled();
    expect(
      await notifyUsers(owner, [
        { userId: owner.id, type: "TASK_ASSIGNED" },
        { userId: owner.id, type: "TASK_DUE_SOON" },
      ]),
    ).toBe(2);
    const rows = await db.notification.findMany({ where: { userId: owner.id } });
    expect(emitChange).toHaveBeenCalledTimes(2);
    for (const row of rows) {
      expect(emitChange).toHaveBeenCalledWith({
        entityType: "notification",
        id: row.id,
        op: "created",
      });
    }
  });
});
