import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { NotificationType } from "~/generated/prisma/enums";
import { unreadNotificationCount, listNotifications } from "../notifications.queries.server";
import {
  markAllNotificationsRead,
  markNotificationRead,
  notifyTaskAssignedInTx,
  notifyUsers,
  sweepDueSoon,
} from "../notifications.mutations.server";
import { setTaskAssignees } from "~/domains/tasks/tasks.mutations.server";
import { createTask } from "~/domains/tasks/tasks.mutations.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";

/**
 * Notification-center guards: creation + realtime-visible rows, ownership on
 * mark-read, the due-soon sweep's dedup, and the assignment trigger firing
 * inside the task mutation's own transaction. Synthetic fixtures only; the
 * Notification rows and the task are deleted in afterAll (ActivityLog is
 * append-only and stays).
 */

const RUN = `ntf_${Date.now().toString(36)}`;

let admin: { id: string; name: string };
let member: { id: string; name: string };
let actor: AuditActor;
let taskId: string;

beforeAll(async () => {
  admin = await db.user.create({
    data: { email: `${RUN}-admin@jiangtang.test`, name: `${RUN} Admin`, role: "ADMIN" },
  });
  member = await db.user.create({
    data: { email: `${RUN}-member@jiangtang.test`, name: `${RUN} Member`, role: "MEMBER" },
  });
  actor = { id: admin.id, name: admin.name };
  const task = await createTask(actor, {
    title: `${RUN} Aufgabe`,
    body: "",
    status: "TODO",
    labels: [],
  });
  taskId = task.id;
});

afterAll(async () => {
  await db.notification.deleteMany({ where: { userId: { in: [admin.id, member.id] } } });
  await db.task.delete({ where: { id: taskId } }).catch(() => undefined);
  await db.user.delete({ where: { id: admin.id } });
  await db.user.delete({ where: { id: member.id } });
  await db.$disconnect();
});

describe("notifyUsers + reads", () => {
  it("creates rows and counts unread per user", async () => {
    const n = await notifyUsers(actor, [
      {
        userId: member.id,
        type: NotificationType.TASK_ASSIGNED,
        entityType: "task",
        entityId: taskId,
        data: { title: "x" },
      },
    ]);
    expect(n).toBe(1);
    expect(await unreadNotificationCount(member.id)).toBe(1);
    expect(await unreadNotificationCount(admin.id)).toBe(0);
    const rows = await listNotifications(member.id);
    expect(rows[0]?.type).toBe(NotificationType.TASK_ASSIGNED);
    expect(rows[0]?.entityId).toBe(taskId);
  });

  it("markNotificationRead only works for the owner", async () => {
    const [row] = await listNotifications(member.id);
    await expect(markNotificationRead({ id: member.id, name: "m" }, row!.id)).resolves.toBeTruthy();
    // A different user cannot mark someone else's row read.
    const again = await notifyUsers(actor, [
      {
        userId: member.id,
        type: NotificationType.TASK_DUE_SOON,
        entityType: "task",
        entityId: taskId,
      },
    ]);
    expect(again).toBe(1);
    const [row2] = await listNotifications(member.id, { unreadOnly: true });
    await expect(markNotificationRead({ id: admin.id, name: "a" }, row2!.id)).rejects.toThrow();
    expect(await unreadNotificationCount(member.id)).toBe(1);
    await markAllNotificationsRead({ id: member.id, name: "m" });
    expect(await unreadNotificationCount(member.id)).toBe(0);
  });
});

describe("assignment trigger", () => {
  it("setTaskAssignees notifies added assignees inside the mutation, not the actor", async () => {
    await setTaskAssignees(actor, taskId, [{ userId: member.id }]);
    const rows = await listNotifications(member.id, { unreadOnly: true });
    expect(
      rows.some((r) => r.type === NotificationType.TASK_ASSIGNED && r.entityId === taskId),
    ).toBe(true);
    // The actor (admin) assigned, so admin gets nothing.
    expect(await listNotifications(admin.id, { unreadOnly: true })).toEqual([]);
  });

  it("createTask with assignees notifies them in the same transaction", async () => {
    const t = await createTask(
      actor,
      { title: `${RUN} zweit`, body: "", status: "TODO", labels: [] },
      [{ userId: member.id }],
    );
    const rows = await listNotifications(member.id);
    expect(rows.some((r) => r.type === NotificationType.TASK_ASSIGNED && r.entityId === t.id)).toBe(
      true,
    );
    await db.notification.deleteMany({ where: { entityId: t.id } });
    await db.task.delete({ where: { id: t.id } });
  });

  it("notifyTaskAssignedInTx skips the actor (self-assignment is not news)", async () => {
    await txWithAudit(null, async (tx) => {
      await notifyTaskAssignedInTx(tx, { id: taskId, title: "t" }, [admin.id], admin.id);
    });
    expect(await listNotifications(admin.id, { unreadOnly: true })).toEqual([]);
  });
});

describe("due-soon sweep", () => {
  it("notifies assignees of open tasks due within the horizon, once", async () => {
    // A fresh task: the mark-read test above already left a TASK_DUE_SOON row
    // for `taskId`, and the sweep dedups on (user, type, entity) — reusing it
    // would test the dedup, not the creation.
    const dueTask = await createTask(
      actor,
      {
        title: `${RUN} fällig`,
        body: "",
        status: "TODO",
        labels: [],
        dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      [{ userId: member.id }],
    );
    try {
      const first = await sweepDueSoon({ horizonHours: 48 });
      expect(first).toBeGreaterThanOrEqual(1);
      const second = await sweepDueSoon({ horizonHours: 48 });
      expect(second).toBe(0); // deduplicated

      const rows = await listNotifications(member.id);
      expect(
        rows.some((r) => r.type === NotificationType.TASK_DUE_SOON && r.entityId === dueTask.id),
      ).toBe(true);
    } finally {
      await db.notification.deleteMany({ where: { entityId: dueTask.id } });
      await db.task.delete({ where: { id: dueTask.id } });
    }
  });
});
