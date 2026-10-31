import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { createTask } from "~/domains/tasks/tasks.mutations.server";
import {
  raiseTaskFromTicket,
  raiseTicketFromTask,
  unlinkTicket,
} from "~/domains/tasks/tasks.harmony.server";
import type { TaskCreateInput } from "~/domains/tasks/tasks.schema";

/**
 * The ticket ⇄ task harmony pair. Two named relations
 * (`Task.ticketId`, `Ticket.taskId`) and one rule: both columns move inside ONE
 * `txWithAudit` transaction, and each entity's audit row is written by the
 * folder that owns the model (`tasks/` never writes `Ticket` — the ticket-side
 * writes go through `createTicketInTx` / `setTicketPrimaryTaskInTx`).
 *
 * What each test pins:
 *   - both raise directions set BOTH columns and write one audit row per entity
 *   - a failure mid-transaction leaves neither row changed
 *   - unlink nulls the task side and — only when it points back — the ticket side
 *   - deleting the ticket leaves the task with `ticketId = null` (FK SetNull)
 *   - every refusal writes no audit row
 */

const RUN = `harm_${Date.now().toString(36)}`;
const actor = { id: null, name: "Harmony Tester", initials: "HT" };

const taskIds: string[] = [];
const ticketIds: string[] = [];
const userIds: string[] = [];

afterAll(async () => {
  for (const id of [...taskIds].reverse()) {
    await db.task.delete({ where: { id } }).catch(() => undefined);
  }
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

function input(over: Partial<TaskCreateInput> & { title: string }): TaskCreateInput {
  return {
    body: undefined,
    status: "TODO",
    priority: undefined,
    startAt: undefined,
    dueAt: undefined,
    estimateMinutes: undefined,
    projectId: undefined,
    parentTaskId: undefined,
    locationId: undefined,
    labels: [],
    ...over,
  };
}

async function makeTask(over: Partial<TaskCreateInput> & { title: string }) {
  const task = await createTask(actor, input(over));
  taskIds.push(task.id);
  return task;
}

async function makeTicket(over: Record<string, unknown> = {}) {
  const ticket = await db.ticket.create({
    data: { type: "INCIDENT", title: `${RUN}-ticket`, ...over },
  });
  ticketIds.push(ticket.id);
  return ticket;
}

async function makeUser(tag: string) {
  const user = await db.user.create({
    data: {
      email: `${RUN}-${tag}@test.local`,
      name: `${RUN} ${tag}`,
      initials: `${RUN.slice(-3)}${tag}`,
    },
  });
  userIds.push(user.id);
  return user;
}

const taskAudit = (id: string) =>
  db.activityLog.findMany({
    where: { entityType: "task", entityId: id },
    orderBy: { occurredAt: "asc" },
  });
const ticketAudit = (id: string) =>
  db.activityLog.findMany({
    where: { entityType: "ticket", entityId: id },
    orderBy: { occurredAt: "asc" },
  });

describe("raiseTicketFromTask", () => {
  it("sets BOTH columns, maps priority, copies assignees — one audit row per entity", async () => {
    const u = await makeUser("ra");
    const task = await makeTask({
      title: `${RUN}-raise`,
      body: "aus der Aufgabe",
      priority: "HIGH",
    });
    await db.taskAssignees.create({ data: { taskId: task.id, userId: u.id, estimateMinutes: 30 } });

    const { ticket } = await raiseTicketFromTask(actor, task.id, { type: "INCIDENT" });
    ticketIds.push(ticket.id);

    const t = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    const k = await db.ticket.findUniqueOrThrow({
      where: { id: ticket.id },
      include: { assignees: { select: { id: true } } },
    });
    expect(t.ticketId).toBe(ticket.id); // task → ticket
    expect(k.taskId).toBe(task.id); // ticket → task (written by createTicketInTx)
    expect(k.status).toBe("OPEN");
    expect(k.title).toBe(task.title); // defaulted from the task
    expect(k.description).toBe("aus der Aufgabe");
    expect(k.priority).toBe(2); // HIGH → 2, the workitem scale
    expect(k.assignees.map((a) => a.id)).toEqual([u.id]);

    expect((await taskAudit(task.id)).map((l) => l.action)).toEqual([
      "TaskCreated",
      "TaskTicketLinked",
    ]);
    expect((await ticketAudit(ticket.id)).map((l) => l.action)).toEqual(["TicketCreated"]);
  });

  it("refuses a second raise on a linked task — no row, no audit", async () => {
    const task = await makeTask({ title: `${RUN}-dup-raise` });
    const { ticket } = await raiseTicketFromTask(actor, task.id, { type: "REQUEST" });
    ticketIds.push(ticket.id);

    const before = (await taskAudit(task.id)).length;
    await expect(raiseTicketFromTask(actor, task.id, { type: "REQUEST" })).rejects.toThrow(
      ValidationError,
    );
    expect(await db.ticket.count({ where: { taskId: task.id } })).toBe(1); // still just the first
    expect((await taskAudit(task.id)).length).toBe(before);
  });

  it("a mid-transaction failure leaves neither side changed and no audit row", async () => {
    const task = await makeTask({ title: `${RUN}-fail` });
    const taskLogs = (await taskAudit(task.id)).length;

    // An invalid TicketType reaches createTicketInTx inside the transaction and
    // throws — the task-side update must roll back with it.
    await expect(
      raiseTicketFromTask(actor, task.id, { type: "NOT_A_TYPE" as never }),
    ).rejects.toThrow();
    expect(await db.ticket.count({ where: { taskId: task.id } })).toBe(0);
    expect((await db.task.findUniqueOrThrow({ where: { id: task.id } })).ticketId).toBeNull();
    expect((await taskAudit(task.id)).length).toBe(taskLogs);
  });

  it("a missing task is a NotFoundError", async () => {
    await expect(raiseTicketFromTask(actor, `${RUN}-gone`, { type: "INCIDENT" })).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("raiseTaskFromTicket", () => {
  it("sets BOTH columns, maps priority back, copies assignees — one audit row per entity", async () => {
    const u = await makeUser("rb");
    const ticket = await makeTicket({ description: "aus dem Ticket", priority: 4 });
    await db.ticket.update({
      where: { id: ticket.id },
      data: { assignees: { connect: { id: u.id } } },
    });

    const { task } = await raiseTaskFromTicket(actor, ticket.id);
    taskIds.push(task.id);

    const t = await db.task.findUniqueOrThrow({
      where: { id: task.id },
      include: { assignees: true },
    });
    const k = await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(t.ticketId).toBe(ticket.id); // task → ticket
    expect(k.taskId).toBe(task.id); // ticket → task (via setTicketPrimaryTaskInTx)
    expect(t.status).toBe("TODO");
    expect(t.title).toBe(ticket.title);
    expect(t.body).toBe("aus dem Ticket");
    expect(t.priority).toBe("LOW"); // 4 → LOW, the workitem scale in reverse
    expect(t.assignees.map((a) => a.userId)).toEqual([u.id]);

    expect((await taskAudit(task.id)).map((l) => l.action)).toEqual(["TaskCreated"]);
    expect((await ticketAudit(ticket.id)).map((l) => l.action)).toEqual(["TicketTaskLinked"]);
  });

  it("refuses a second raise on a linked ticket — no row, no audit", async () => {
    const ticket = await makeTicket();
    const { task } = await raiseTaskFromTicket(actor, ticket.id);
    taskIds.push(task.id);

    const before = (await ticketAudit(ticket.id)).length;
    await expect(raiseTaskFromTicket(actor, ticket.id)).rejects.toThrow(ValidationError);
    expect(await db.task.count({ where: { ticketId: ticket.id } })).toBe(1); // still just the first
    expect((await ticketAudit(ticket.id)).length).toBe(before);
  });
});

describe("unlinkTicket", () => {
  it("nulls the task side and — because the ticket points back — the ticket side too", async () => {
    const task = await makeTask({ title: `${RUN}-unlink` });
    const { ticket } = await raiseTicketFromTask(actor, task.id, { type: "REPAIR" });
    ticketIds.push(ticket.id);

    const updated = await unlinkTicket(actor, task.id);
    expect(updated.ticketId).toBeNull();
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).taskId).toBeNull();

    expect((await taskAudit(task.id)).map((l) => l.action)).toEqual([
      "TaskCreated",
      "TaskTicketLinked",
      "TaskTicketUnlinked",
    ]);
    expect((await ticketAudit(ticket.id)).map((l) => l.action)).toEqual([
      "TicketCreated",
      "TicketTaskUnlinked",
    ]);
  });

  it("leaves a ticket-side link alone when it points at a DIFFERENT task", async () => {
    const a = await makeTask({ title: `${RUN}-u1` });
    const b = await makeTask({ title: `${RUN}-u2` });
    const { ticket } = await raiseTicketFromTask(actor, a.id, { type: "INCIDENT" });
    ticketIds.push(ticket.id);
    // Hand the ticket's primary-task link to b (b.ticketId stays null).
    await db.ticket.update({ where: { id: ticket.id }, data: { taskId: b.id } });

    await unlinkTicket(actor, a.id);
    expect((await db.task.findUniqueOrThrow({ where: { id: a.id } })).ticketId).toBeNull();
    // The ticket still points at b — unlink only severs the back-reference
    // when it names this task.
    expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).taskId).toBe(b.id);
    expect((await ticketAudit(ticket.id)).map((l) => l.action)).toEqual(["TicketCreated"]); // no TicketTaskUnlinked
  });

  it("refuses an unlinked task — no audit row", async () => {
    const task = await makeTask({ title: `${RUN}-no-link` });
    const before = (await taskAudit(task.id)).length;
    await expect(unlinkTicket(actor, task.id)).rejects.toThrow(ValidationError);
    expect((await taskAudit(task.id)).length).toBe(before);
  });
});

describe("FK behaviour", () => {
  it("deleting the ticket leaves the task intact with ticketId = null (SetNull)", async () => {
    const task = await makeTask({ title: `${RUN}-setnull` });
    // Deliberately NOT tracked in ticketIds — this ticket is deleted here.
    const { ticket } = await raiseTicketFromTask(actor, task.id, { type: "INCIDENT" });

    await db.ticket.delete({ where: { id: ticket.id } });
    const t = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.ticketId).toBeNull();
  });
});
