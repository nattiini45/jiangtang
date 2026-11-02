import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { berlinDayKey } from "~/domains/tasks/tasks.dates";
import { berlinLocalToUtc } from "~/lib/time.server";
import { getDueSummary, getMyWork, listBlockedTasks } from "~/domains/tasks/tasks.queries.server";
import { listMyTickets } from "~/domains/tickets/tickets.queries.server";
import { getStorageStats } from "~/domains/attachments/attachments.queries.server";
import { workspaceIsEmpty } from "~/domains/dashboard/dashboard.queries.server";
import { getSearchHealth } from "~/lib/search/health.server";
import { createTask, setTaskStatus } from "~/domains/tasks/tasks.mutations.server";
import { addTaskBlocker } from "~/domains/tasks/tasks.dependencies.server";
import { createTicket } from "~/domains/tickets/tickets.mutations.server";

/**
 * The dashboard's card queries, against fixture data. The Berlin-day
 * boundary cases are the load-bearing part: a due time of 23:30 Berlin still
 * belongs to *today* (the stored instant may sit in the next UTC day in
 * summer), and 00:30 Berlin in winter sits in the PREVIOUS UTC day.
 */
const RUN = `dashboard_${Date.now().toString(36)}`;

const taskIds: string[] = [];
const ticketIds: string[] = [];
const userIds: string[] = [];

/** Unique initials — the column is globally unique, so derive from RUN. */
async function mkUser(tag: string) {
  const initials = `${RUN.slice(-2)}${tag}`.toUpperCase();
  const u = await db.user.create({
    data: { email: `${RUN}-${tag}@test.local`, name: `${RUN} ${tag}`, initials },
  });
  userIds.push(u.id);
  return u;
}

const inBerlin = (dayKey: string, hm: string) => berlinLocalToUtc(`${dayKey}T${hm}`);

async function mkTask(data: {
  title: string;
  status?: "BACKLOG" | "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "BLOCKED" | "DONE" | "CANCELLED";
  dueAt?: Date;
  estimateMinutes?: number;
}) {
  const t = await db.task.create({
    data: {
      title: `${RUN} ${data.title}`,
      status: data.status ?? "TODO",
      dueAt: data.dueAt ?? null,
      estimateMinutes: data.estimateMinutes ?? null,
      labels: [],
    },
  });
  taskIds.push(t.id);
  return t;
}

afterAll(async () => {
  await db.taskAssignees.deleteMany({ where: { taskId: { in: taskIds } } });
  await db.taskDependency.deleteMany({
    where: { OR: [{ blockedByTaskId: { in: taskIds } }, { blockingTaskId: { in: taskIds } }] },
  });
  for (const id of [...taskIds].reverse())
    await db.task.delete({ where: { id } }).catch(() => undefined);
  for (const id of [...ticketIds].reverse())
    await db.ticket.delete({ where: { id } }).catch(() => undefined);
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("getDueSummary — Berlin-day boundaries", () => {
  it("counts a task due at 23:30 Berlin as due today, not tomorrow", async () => {
    const before = await getDueSummary();
    const t = await mkTask({
      title: "late-day",
      dueAt: inBerlin(berlinDayKey(new Date()), "23:30"),
    });
    const after = await getDueSummary();
    expect(after.dueToday.some((x) => x.id === t.id)).toBe(true);
    expect(after.dueTodayCount).toBe(before.dueTodayCount + 1);
    expect(after.overdueCount).toBe(before.overdueCount);
  });

  it("counts a task due at 00:30 Berlin — the previous UTC day — as today too", async () => {
    const before = await getDueSummary();
    const t = await mkTask({
      title: "early-day",
      dueAt: inBerlin(berlinDayKey(new Date()), "00:30"),
    });
    const after = await getDueSummary();
    expect(after.dueTodayCount).toBe(before.dueTodayCount + 1);
    expect(after.overdueCount).toBe(before.overdueCount);
    void t;
  });

  it("yesterday's open task is overdue; tomorrow's and DONE tasks are neither", async () => {
    const before = await getDueSummary();
    const yesterday = berlinDayKey(new Date(Date.now() - 864e5));
    const tomorrow = berlinDayKey(new Date(Date.now() + 864e5));
    await mkTask({ title: "yesterday", dueAt: inBerlin(yesterday, "23:30") });
    await mkTask({ title: "tomorrow", dueAt: inBerlin(tomorrow, "00:00") });
    await mkTask({
      title: "done-today",
      status: "DONE",
      dueAt: inBerlin(berlinDayKey(new Date()), "12:00"),
    });
    const after = await getDueSummary();
    expect(after.dueTodayCount).toBe(before.dueTodayCount);
    expect(after.overdueCount).toBe(before.overdueCount + 1);
  });
});

describe("listBlockedTasks", () => {
  it("lists an open task with an open blocker, and drops it once the blocker settles", async () => {
    const me = await mkUser("bl");
    const blocker = await createTask(me, { title: `${RUN} blocker`, status: "TODO", labels: [] });
    const blocked = await createTask(me, { title: `${RUN} blocked`, status: "TODO", labels: [] });
    taskIds.push(blocker.id, blocked.id);
    await addTaskBlocker(me, blocked.id, blocker.id);

    const rows = await listBlockedTasks(200);
    const row = rows.find((t) => t.id === blocked.id);
    expect(row?.openBlockers.map((b) => b.id)).toContain(blocker.id);

    await setTaskStatus(me, blocker.id, "DONE");
    expect((await listBlockedTasks(200)).some((t) => t.id === blocked.id)).toBe(false);
  });

  it("lists status BLOCKED even with no dependency edge", async () => {
    const t = await mkTask({ title: "marked-blocked", status: "BLOCKED" });
    const rows = await listBlockedTasks(500);
    expect(rows.some((x) => x.id === t.id)).toBe(true);
  });
});

describe("getMyWork + listMyTickets", () => {
  it("sums my TaskAssignees share and falls back to an equal split", async () => {
    const me = await mkUser("me");
    const u2 = await mkUser("u2");
    const u3 = await mkUser("u3");

    // Mine alone, with an explicit share of 30.
    const a = await createTask(me, { title: `${RUN} mine30`, status: "TODO", labels: [] }, [
      { userId: me.id, estimateMinutes: 30 },
    ]);
    // Shared three ways, no per-assignee share → 90 / 3 = 30 for me.
    const b = await createTask(
      me,
      { title: `${RUN} shared90`, status: "TODO", estimateMinutes: 90, labels: [] },
      [{ userId: me.id }, { userId: u2.id }, { userId: u3.id }],
    );
    taskIds.push(a.id, b.id);

    const work = await getMyWork(me.id);
    expect(work.taskCount).toBe(2);
    expect(work.estimateMinutes).toBe(60);
    expect(work.tasks.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("returns my open tickets, never settled ones", async () => {
    const me = await mkUser("tk");
    const open = await createTicket(me, {
      type: "INCIDENT",
      title: `${RUN} open`,
      assigneeIds: [me.id],
      status: "OPEN",
    });
    const done = await createTicket(me, {
      type: "INCIDENT",
      title: `${RUN} resolved`,
      assigneeIds: [me.id],
      status: "RESOLVED",
      resolution: "erledigt",
    });
    ticketIds.push(open.id, done.id);

    const { tickets, ticketCount } = await listMyTickets(me.id);
    expect(ticketCount).toBe(1);
    expect(tickets[0].id).toBe(open.id);
  });
});

describe("getStorageStats + getSearchHealth", () => {
  it("reports the live attachment count, byte total and a backend label", async () => {
    const stats = await getStorageStats();
    expect(stats.attachmentCount).toBe(await db.attachment.count());
    expect(stats.totalBytes).toBeGreaterThanOrEqual(0);
    expect(typeof stats.backend).toBe("string");
    expect(stats.backend.length).toBeGreaterThan(0);
  });

  it("reports real index health — lexical state when no embedder is configured", async () => {
    // Replaced the stub: state from getIndexStats + capability statuses.
    const health = await getSearchHealth();
    expect(health.state).toBe("lexical");
    expect(health.chunks).toBe(await db.chunk.count());
    expect(health.note).toContain("Stichwortsuche");
  });
});

describe("workspaceIsEmpty — the first-run gate", () => {
  it("is false while the workspace holds any of the four counted models", async () => {
    // The dev corpus is seeded; any one row would already flip this to false.
    expect(await workspaceIsEmpty()).toBe(false);
  });

  it("is true only when tasks, projects, notes AND stock are all zero", async () => {
    class Rollback extends Error {}
    try {
      await db.$transaction(async (tx) => {
        await tx.taskDependency.deleteMany();
        await tx.taskAssignees.deleteMany();
        // Self-FK is RESTRICT — children before parents.
        await tx.task.deleteMany({ where: { parentTaskId: { not: null } } });
        await tx.task.deleteMany();
        await tx.note.deleteMany();
        await tx.project.deleteMany({ where: { parentProjectId: { not: null } } });
        await tx.project.deleteMany();
        await tx.inventoryItem.deleteMany();
        expect(await workspaceIsEmpty(tx)).toBe(true);
        // And still false while any one kind remains — reinstate one note.
        const u = await tx.user.create({
          data: {
            email: `${RUN}-empty@test.local`,
            name: `${RUN} empty`,
            initials: `${RUN.slice(-1)}E`.toUpperCase(),
          },
        });
        await tx.note.create({ data: { title: `${RUN} survivor`, body: "", authorId: u.id } });
        expect(await workspaceIsEmpty(tx)).toBe(false);
        throw new Rollback();
      });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  });
});
