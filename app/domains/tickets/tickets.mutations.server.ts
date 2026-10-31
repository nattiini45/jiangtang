import { tr } from "~/i18n/request-locale.server";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { TicketStatus } from "~/generated/prisma/enums";
import type { Ticket } from "~/generated/prisma/client";
import type { Tx } from "~/lib/db.server";
import type { TicketCreateInput, TicketEditInput, TicketTransitionInput } from "./tickets.schema";
import { laneOfTicketStatus, TICKET_LANE_STATUS, type Lane } from "~/domains/tasks/tasks.lanes";

/**
 * Tickets-domain mutations. Every write funnels through txWithAudit so the
 * ActivityLog row commits in the same transaction as the change.
 * The route action emits `emitChange({ entityType: "ticket" })` post-commit.
 */

const isResolved = (s: TicketStatus) => s === TicketStatus.RESOLVED;
const isOpenish = (s: TicketStatus) => s === TicketStatus.OPEN || s === TicketStatus.IN_PROGRESS;

/**
 * Legal status moves. Enforced server-side so a stale browser tab or a direct
 * POST can't drive an illegal transition (e.g. re-resolving an already-resolved
 * ticket, which would silently overwrite its resolution). Mirrors the buttons the
 * detail UI renders. Same-status (no-op) moves are intentionally excluded.
 */
const ALLOWED_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ["IN_PROGRESS", "RESOLVED", "CANCELLED"],
  IN_PROGRESS: ["OPEN", "RESOLVED", "CANCELLED"],
  RESOLVED: ["OPEN", "IN_PROGRESS"],
  CANCELLED: ["OPEN", "IN_PROGRESS"],
};

/** Optional links (room / equipment / event). Empty → null (detached). */
function ticketLinks(input: { roomId?: string; equipmentId?: string; eventId?: string }) {
  return {
    roomId: input.roomId ?? null,
    equipmentId: input.equipmentId ?? null,
    eventId: input.eventId ?? null,
  };
}

/**
 * The in-transaction half of `createTicket` — the `createEquipmentInTx`
 * precedent: another domain's transaction can compose a ticket creation
 * WITHOUT this file owning the commit, while the Ticket write and its audit row
 * still live in the folder that owns the model (`tasks.harmony.server`
 * is the caller this exists for).
 *
 * `taskId` is the harmony link: set when the ticket is raised
 * from a task. `reporterId` is NOT defaulted from the actor here — the caller
 * owns that choice (the actor is not an argument of this function), so
 * `createTicket` folds its own `actor.id` default in before delegating.
 */
export async function createTicketInTx(
  tx: Tx,
  audit: AuditFn,
  input: TicketCreateInput & { taskId?: string },
): Promise<Ticket> {
  const resolved = isResolved(input.status);
  const ticket = await tx.ticket.create({
    data: {
      type: input.type,
      status: input.status,
      title: input.title,
      description: input.description ?? null,
      resolution: input.resolution ?? null,
      priority: input.priority ?? null,
      ...ticketLinks(input),
      taskId: input.taskId ?? null,
      reporterId: input.reporterId ?? null,
      assignees: input.assigneeIds.length
        ? { connect: input.assigneeIds.map((id) => ({ id })) }
        : undefined,
      occurredAt: input.occurredAt ?? undefined,
      // resolvedAt only makes sense on a resolved ticket — never stamp it on an
      // OPEN/IN_PROGRESS create, even if the form posted a date.
      resolvedAt: resolved ? (input.resolvedAt ?? input.occurredAt ?? new Date()) : null,
    },
  });
  await audit({
    action: resolved ? "TicketResolved" : "TicketCreated",
    entityType: "ticket",
    entityId: ticket.id,
    data: { type: ticket.type, title: ticket.title, bornResolved: resolved || undefined },
    occurredAt: input.occurredAt ?? undefined,
  });
  return ticket;
}

/**
 * Create a ticket. A born-resolved entry (status RESOLVED at creation — a logged
 * past repair) carries its resolution and stamps resolvedAt to the occurrence
 * time, so the logbook reads truthfully even when back-dated.
 */
export async function createTicket(actor: AuditActor, input: TicketCreateInput): Promise<Ticket> {
  return txWithAudit(actor, (tx, audit) =>
    createTicketInTx(tx, audit, {
      ...input,
      reporterId: input.reporterId ?? actor.id ?? undefined,
    }),
  );
}

/**
 * Set `Ticket.taskId` — the ticket's primary-task link. The
 * ONLY writer of that column: the tasks domain never touches `Ticket` directly
 * (the domain-ownership rule), so the raise/unlink flows in
 * `tasks.harmony.server.ts` compose this inside their own `txWithAudit`.
 * Audited `TicketTaskLinked` / `TicketTaskUnlinked` on the ticket.
 */
export async function setTicketPrimaryTaskInTx(
  tx: Tx,
  audit: AuditFn,
  ticketId: string,
  taskId: string | null,
): Promise<Ticket> {
  const before = await tx.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, taskId: true },
  });
  if (!before) throw new NotFoundError(tr("work.err.ticket.notFound"));
  const ticket = await tx.ticket.update({ where: { id: ticketId }, data: { taskId } });
  await audit({
    action: taskId ? "TicketTaskLinked" : "TicketTaskUnlinked",
    entityType: "ticket",
    entityId: ticketId,
    data: { from: before.taskId, to: taskId },
  });
  return ticket;
}

/**
 * Edit ticket content (never status — that moves through transitionTicket).
 * Assignees are replaced wholesale via `set`.
 */
export async function updateTicket(
  actor: AuditActor,
  id: string,
  input: TicketEditInput,
): Promise<Ticket> {
  return txWithAudit(actor, async (tx, audit) => {
    const ticket = await tx.ticket.update({
      where: { id },
      data: {
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? null,
        ...ticketLinks(input),
        // Only touch reporterId when the form actually supplied a value —
        // `undefined` here means "omitted", not "clear it", so a partial edit
        // (or a form that doesn't render the reporter field) doesn't silently
        // detach the existing reporter.
        ...(input.reporterId !== undefined ? { reporterId: input.reporterId } : {}),
        assignees: { set: input.assigneeIds.map((aid) => ({ id: aid })) },
        occurredAt: input.occurredAt ?? undefined,
      },
    });
    await audit({ action: "TicketUpdated", entityType: "ticket", entityId: ticket.id });
    return ticket;
  });
}

/**
 * The in-transaction half of `transitionTicket` (the `createTicketInTx`
 * precedent): the guarded status move — `ALLOWED_TRANSITIONS`, resolvedAt
 * side-effects, the precise audit verb — composed inside a caller's
 * `txWithAudit`. `moveTicketToLane` is the caller this exists for, so a
 * board drag goes through exactly the transition rules a button click does.
 */
export async function transitionTicketInTx(
  tx: Tx,
  audit: AuditFn,
  id: string,
  input: TicketTransitionInput,
): Promise<Ticket> {
  const current = await tx.ticket.findUnique({
    where: { id },
    select: { status: true, resolvedAt: true },
  });
  if (!current) throw new NotFoundError(tr("work.err.ticket.notFound"));

  if (!ALLOWED_TRANSITIONS[current.status].includes(input.status)) {
    const message = tr("work.err.ticket.invalidTransition", {
      from: current.status,
      to: input.status,
    });
    // The transition form (route) renders no `status` field, so a field-keyed
    // error would be silently dropped — surface it as a general form error too
    // so a rejected illegal transition is visible instead of a silent no-op.
    throw new ValidationError({ status: [message] }, [message]);
  }

  const resolved = isResolved(input.status);
  const reopened = isOpenish(input.status);

  const ticket = await tx.ticket.update({
    where: { id },
    data: {
      status: input.status,
      // Resolving sets the resolution; reopening clears it (and resolvedAt
      // below); cancelling leaves both as-is.
      ...(resolved
        ? { resolution: input.resolution ?? null }
        : reopened
          ? { resolution: null }
          : {}),
      resolvedAt: resolved ? (current.resolvedAt ?? new Date()) : reopened ? null : undefined,
    },
  });

  const verb = resolved
    ? "TicketResolved"
    : input.status === TicketStatus.CANCELLED
      ? "TicketCancelled"
      : input.status === TicketStatus.IN_PROGRESS
        ? "TicketStarted"
        : "TicketReopened";
  await audit({
    action: verb,
    entityType: "ticket",
    entityId: ticket.id,
    data: { from: current.status, to: input.status },
  });
  return ticket;
}

/**
 * Guarded status move. Illegal from→to moves are rejected server-side (not just
 * hidden in the UI). Resolving stamps resolvedAt + resolution; reopening clears
 * BOTH side-effects so an OPEN ticket never carries a stale "solved" payload;
 * cancelling leaves them untouched. Each transition audits a precise verb with
 * { from, to } so the history feed reads as a workflow.
 */
export async function transitionTicket(
  actor: AuditActor,
  id: string,
  input: TicketTransitionInput,
): Promise<Ticket> {
  return txWithAudit(actor, (tx, audit) => transitionTicketInTx(tx, audit, id, input));
}

/**
 * `/board` work mode: drop a ticket card on a lane → the ticket takes
 * `TICKET_LANE_STATUS[lane]` through the same guarded transition the detail
 * buttons use — identical `ALLOWED_TRANSITIONS` and audit verbs. IN_REVIEW has
 * no ticket status, so a drop there is refused; a drop in the ticket's current
 * lane is a no-op (no write, no audit); an illegal from→to pair is refused with
 * the transition message.
 */
export async function moveTicketToLane(
  actor: AuditActor,
  ticketId: string,
  lane: Lane,
): Promise<Ticket> {
  const status = TICKET_LANE_STATUS[lane];
  if (!status) {
    throw new ValidationError({}, [tr("work.err.ticket.noReviewLane")]);
  }
  return txWithAudit(actor, async (tx, audit) => {
    const current = await tx.ticket.findUnique({ where: { id: ticketId } });
    if (!current) throw new NotFoundError(tr("work.err.ticket.notFound"));
    if (laneOfTicketStatus(current.status) === lane) return current; // same lane — no-op
    return transitionTicketInTx(tx, audit, ticketId, { status });
  });
}
