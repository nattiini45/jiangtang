import { tr } from "~/i18n/request-locale.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import type { Task, TaskPriority, Ticket } from "~/generated/prisma/client";
import type { TicketType } from "~/generated/prisma/enums";
import {
  createTicketInTx,
  setTicketPrimaryTaskInTx,
} from "~/domains/tickets/tickets.mutations.server";
import { laneOfTaskStatus } from "./tasks.lanes";
import { laneTailPosition } from "./tasks.mutations.server";

/**
 * Ticket ⇄ task harmony writes. A task and a ticket can
 * point at each other — `Task.ticketId` (the task's ticket) and `Ticket.taskId`
 * (the ticket's primary task) are TWO named relations, and each raise keeps
 * **both columns** consistent inside ONE `txWithAudit` transaction: either the
 * whole pair commits or nothing does.
 *
 * The domain-ownership rule is honoured the same way `createEquipmentInTx`
 * honours it: this file never writes `Ticket` — ticket-side writes go through
 * `createTicketInTx` / `setTicketPrimaryTaskInTx`, which live in (and are
 * audited by) the folder that owns the model. Reads are free; the
 * cross-folder-writes guard only counts delegate writes.
 *
 * The refusals — raising a second ticket on a linked task, raising a second
 * task on a linked ticket, unlinking a task that is not linked — write
 * nothing: no row, no audit.
 */

/**
 * TaskPriority → the ticket's `Int?` scale, exactly as `workitem.sort_priority`
 * maps it (`20261023000500_workitem_view`): URGENT = 1 … LOWEST = 5.
 * The reverse map is literal: a ticket priority the scale cannot name (there is
 * no DB constraint — the 1–3 bound lives in the zod form schema) maps to
 * `null`, "unprioritised", rather than being clamped into a lie.
 */
const TASK_PRIORITY_TO_TICKET: Record<TaskPriority, number> = {
  URGENT: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
  LOWEST: 5,
};
const TICKET_PRIORITY_TO_TASK: Record<number, TaskPriority> = {
  1: "URGENT",
  2: "HIGH",
  3: "MEDIUM",
  4: "LOW",
  5: "LOWEST",
};

/**
 * `raiseTicketFromTask(actor, taskId, { type, title?, description? })` — a task
 * that has become a service incident. Refused while `task.ticketId` is set.
 * The ticket is OPEN; title/description default from the task; priority maps
 * onto the workitem scale; the task's assignees are connected to the ticket;
 * `ticket.taskId` and `task.ticketId` are both set. Audits: `TicketCreated` on
 * the ticket (inside `createTicketInTx`), `TaskTicketLinked` on the task.
 */
export async function raiseTicketFromTask(
  actor: AuditActor,
  taskId: string,
  input: { type: TicketType; title?: string; description?: string },
): Promise<{ task: Task; ticket: Ticket }> {
  return txWithAudit(actor, async (tx, audit) => {
    const task = await tx.task.findUnique({
      where: { id: taskId },
      include: { assignees: { select: { userId: true } } },
    });
    if (!task) throw new NotFoundError(tr("work.err.task.notFound"));
    if (task.ticketId) {
      throw new ValidationError({}, [
        tr("work.err.task.alreadyLinkedToTicket", { title: task.title }),
      ]);
    }

    const ticket = await createTicketInTx(tx, audit, {
      type: input.type,
      status: "OPEN",
      title: input.title ?? task.title,
      description: input.description ?? task.body ?? undefined,
      resolution: undefined,
      priority: task.priority ? TASK_PRIORITY_TO_TICKET[task.priority] : undefined,
      roomId: undefined,
      equipmentId: undefined,
      eventId: undefined,
      reporterId: actor.id ?? undefined,
      assigneeIds: task.assignees.map((a) => a.userId),
      occurredAt: undefined,
      resolvedAt: undefined,
      taskId: task.id,
    });

    const updated = await tx.task.update({ where: { id: task.id }, data: { ticketId: ticket.id } });
    await audit({
      action: "TaskTicketLinked",
      entityType: "task",
      entityId: task.id,
      data: { title: task.title, ticketId: ticket.id, ticketTitle: ticket.title },
    });
    return { task: updated, ticket };
  });
}

/**
 * `raiseTaskFromTicket(actor, ticketId, { projectId? })` — the other direction:
 * a ticket that needs planned work. Refused while `ticket.taskId` is set. The
 * task is created as a plain TODO card (title/body/priority from the ticket,
 * `ticketId` set, assignees copied, end of the BACKLOG lane), then the
 * ticket's primary-task link is set through `setTicketPrimaryTaskInTx`.
 * Audits: `TaskCreated` on the task, `TicketTaskLinked` on the ticket.
 */
export async function raiseTaskFromTicket(
  actor: AuditActor,
  ticketId: string,
  input: { projectId?: string } = {},
): Promise<{ task: Task; ticket: Ticket }> {
  return txWithAudit(actor, async (tx, audit) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: ticketId },
      include: { assignees: { select: { id: true } } },
    });
    if (!ticket) throw new NotFoundError(tr("work.err.ticket.notFound"));
    if (ticket.taskId) {
      throw new ValidationError({}, [
        tr("work.err.ticket.alreadyLinkedToTask", { title: ticket.title }),
      ]);
    }
    if (input.projectId) {
      const project = await tx.project.findUnique({
        where: { id: input.projectId },
        select: { id: true },
      });
      if (!project) throw new ValidationError({ projectId: [tr("work.err.project.unknown")] });
    }

    const position = await laneTailPosition(tx, laneOfTaskStatus("TODO"));
    const task = await tx.task.create({
      data: {
        title: ticket.title,
        body: ticket.description,
        status: "TODO",
        priority: ticket.priority ? (TICKET_PRIORITY_TO_TASK[ticket.priority] ?? null) : null,
        projectId: input.projectId ?? null,
        ticketId: ticket.id,
        position,
        createdById: actor.id ?? null,
        assignees: ticket.assignees.length
          ? { create: ticket.assignees.map((u) => ({ userId: u.id, estimateMinutes: null })) }
          : undefined,
      },
    });
    await audit({
      action: "TaskCreated",
      entityType: "task",
      entityId: task.id,
      data: { title: task.title, status: task.status, raisedFromTicketId: ticket.id },
    });

    await setTicketPrimaryTaskInTx(tx, audit, ticket.id, task.id);
    return { task, ticket: await tx.ticket.findUniqueOrThrow({ where: { id: ticket.id } }) };
  });
}

/**
 * `unlinkTicket(actor, taskId)` — sever a link without deleting either side.
 * Refused when the task has no `ticketId`. Nulls `task.ticketId` and, when the
 * ticket's primary-task link points back at this task, nulls that too — via
 * `setTicketPrimaryTaskInTx`, never a direct write.
 */
export async function unlinkTicket(actor: AuditActor, taskId: string): Promise<Task> {
  return txWithAudit(actor, async (tx, audit) => {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundError(tr("work.err.task.notFound"));
    if (!task.ticketId) {
      throw new ValidationError({}, [tr("work.err.task.notLinkedToTicket", { title: task.title })]);
    }

    const ticket = await tx.ticket.findUnique({
      where: { id: task.ticketId },
      select: { id: true, taskId: true },
    });
    const updated = await tx.task.update({ where: { id: task.id }, data: { ticketId: null } });
    await audit({
      action: "TaskTicketUnlinked",
      entityType: "task",
      entityId: task.id,
      data: { title: task.title, ticketId: task.ticketId },
    });
    if (ticket && ticket.taskId === task.id) {
      await setTicketPrimaryTaskInTx(tx, audit, ticket.id, null);
    }
    return updated;
  });
}
