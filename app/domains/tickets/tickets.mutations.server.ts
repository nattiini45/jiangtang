import { tr } from "~/i18n/request-locale.server";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { NotFoundError, TransitionError, ValidationError } from "~/lib/errors.server";
import { TicketStatus } from "~/generated/prisma/enums";
import type { Ticket } from "~/generated/prisma/client";
import { db, type Tx } from "~/lib/db.server";
import { isUniqueViolation } from "~/lib/db-errors.server";
import type { TicketCreateInput, TicketEditInput, TicketTransitionInput } from "./tickets.schema";
import {
  TICKET_TRANSITIONS,
  ticketActionMetadata,
  type TicketTransitionRejection,
} from "./tickets.transitions";
import { laneOfTicketStatus, TICKET_LANE_STATUS, type Lane } from "~/domains/tasks/tasks.lanes";
import { CUID_PATTERN } from "~/domains/transfer/transfer.schema";

/**
 * Tickets-domain mutations. Every write funnels through txWithAudit so the
 * ActivityLog row commits in the same transaction as the change.
 * The route action emits `emitChange({ entityType: "ticket" })` post-commit.
 */

const isResolved = (s: TicketStatus) => s === TicketStatus.RESOLVED;

function validateKnownFix(ticket: {
  keepAsFix?: boolean;
  status: string;
  type: string;
  roomId?: string | null;
  functionId?: string | null;
  resolution?: string | null;
}) {
  if (
    ticket.keepAsFix &&
    (ticket.status !== "RESOLVED" ||
      !["INCIDENT", "REPAIR"].includes(ticket.type) ||
      !ticket.roomId ||
      !ticket.functionId ||
      !ticket.resolution?.trim())
  )
    throw new ValidationError({ keepAsFix: [tr("functions.fixes.invalid")] });
}

async function validateFunctionLinks(
  tx: Tx,
  input: Pick<
    TicketCreateInput,
    "type" | "roomId" | "equipmentId" | "functionId" | "impact" | "keepAsFix"
  >,
) {
  if (input.impact && input.type !== "INCIDENT")
    throw new ValidationError({ impact: [tr("functions.error.impact")] });
  if (!input.functionId) return;
  const definition = await tx.roomFunction.findFirst({
    where: { id: input.functionId, archivedAt: null },
    include: { kinds: true },
  });
  if (!definition || !input.roomId)
    throw new ValidationError({ functionId: [tr("functions.error.function")] });
  if (input.type === "REPAIR" && input.keepAsFix && !input.equipmentId) return;
  const devices = await tx.equipment.findMany({
    where: {
      roomId: input.roomId,
      status: { not: "RETIRED" },
      kindId: { in: definition.kinds.map((link) => link.kindId) },
    },
    select: { id: true },
  });
  if (
    !devices.length ||
    (input.equipmentId && !devices.some((device) => device.id === input.equipmentId))
  )
    throw new ValidationError({ functionId: [tr("functions.error.function")] });
}

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
  input: TicketCreateInput & { taskId?: string; id?: string },
): Promise<Ticket> {
  const resolved = isResolved(input.status);
  validateKnownFix(input);
  await validateFunctionLinks(tx, input);
  const ticket = await tx.ticket.create({
    data: {
      ...(input.id ? { id: input.id } : {}),
      type: input.type,
      status: input.status,
      title: input.title,
      description: input.description ?? null,
      resolution: input.resolution ?? null,
      priority: input.priority ?? null,
      functionId: input.functionId ?? null,
      impact: input.type === "INCIDENT" ? (input.impact ?? "LIMITED") : null,
      channel: input.channel ?? "DESKTOP",
      keepAsFix: input.keepAsFix ?? false,
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
    data: {
      type: ticket.type,
      title: ticket.title,
      bornResolved: resolved || undefined,
      ...(ticket.keepAsFix ? { keepAsFix: true } : {}),
    },
    occurredAt: input.occurredAt ?? undefined,
  });
  return ticket;
}

/**
 * Create a ticket. A born-resolved entry (status RESOLVED at creation — a logged
 * past repair) carries its resolution and stamps resolvedAt to the occurrence
 * time, so the logbook reads truthfully even when back-dated.
 *
 * `clientId` (the offline capture queue's id, cuid-shaped) becomes the ticket's
 * id and makes the create idempotent: a replay of a capture whose first send
 * did arrive returns that ticket — no second row, no second audit entry.
 */
export async function createTicket(
  actor: AuditActor,
  input: TicketCreateInput,
  clientId?: string,
): Promise<Ticket> {
  if (clientId !== undefined && !CUID_PATTERN.test(clientId)) {
    throw new ValidationError({ clientId: [tr("work.err.invalidClientId")] });
  }
  try {
    return await txWithAudit(actor, async (tx, audit) => {
      if (clientId !== undefined) {
        const existing = await tx.ticket.findUnique({ where: { id: clientId } });
        if (existing) return existing;
      }
      return createTicketInTx(tx, audit, {
        ...input,
        reporterId: input.reporterId ?? actor.id ?? undefined,
        ...(clientId !== undefined ? { id: clientId } : {}),
      });
    });
  } catch (error) {
    // Two replays can both pass the lookup above; the loser's insert then hits
    // the primary key after the winner committed, so its row is the answer.
    if (clientId !== undefined && isUniqueViolation(error)) {
      const existing = await db.ticket.findUnique({ where: { id: clientId } });
      if (existing) return existing;
    }
    throw error;
  }
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
    await tx.$queryRaw`SELECT "id" FROM "Ticket" WHERE "id" = ${id} FOR UPDATE`;
    const current = await tx.ticket.findUniqueOrThrow({ where: { id } });
    if (input.resolution !== undefined && current.status !== "RESOLVED")
      throw new ValidationError({ resolution: [tr("functions.fixes.resolvedOnly")] });
    validateKnownFix({
      ...current,
      ...input,
      keepAsFix: input.keepAsFix ?? current.keepAsFix,
      roomId: input.roomId ?? null,
      functionId: input.functionId ?? current.functionId,
      resolution: input.resolution ?? current.resolution,
    });
    if (input.impact && input.type !== "INCIDENT")
      throw new ValidationError({ impact: [tr("functions.error.impact")] });
    const functionId = input.functionId ?? current.functionId ?? undefined;
    const impact =
      input.type === "INCIDENT" ? (input.impact ?? current.impact ?? undefined) : undefined;
    if (
      (input.functionId !== undefined && input.functionId !== current.functionId) ||
      (input.roomId ?? null) !== current.roomId ||
      (input.equipmentId ?? null) !== current.equipmentId
    ) {
      await validateFunctionLinks(tx, { ...input, functionId, impact });
    }
    const ticket = await tx.ticket.update({
      where: { id },
      data: {
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        priority: input.priority ?? null,
        functionId: functionId ?? null,
        impact: impact ?? null,
        ...(input.keepAsFix !== undefined ? { keepAsFix: input.keepAsFix } : {}),
        ...(input.resolution !== undefined ? { resolution: input.resolution } : {}),
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
 * precedent): the guarded status move — transition table, resolvedAt
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
  await tx.$queryRaw`SELECT "id" FROM "Ticket" WHERE "id" = ${id} FOR UPDATE`;
  const current = await tx.ticket.findUnique({
    where: { id },
  });
  if (!current) throw new NotFoundError(tr("work.err.ticket.notFound"));

  const edge = TICKET_TRANSITIONS[current.status].find((edge) => edge.target === input.status);
  if (!edge) {
    const message = tr("work.err.ticket.invalidTransition", {
      from: current.status,
      to: input.status,
    });
    throw new TransitionError(
      {
        entity: "ticket",
        currentState: current.status,
        attemptedTarget: input.status,
        ...ticketActionMetadata(current.status),
        reason: { code: "INVALID_TRANSITION", message },
      } satisfies TicketTransitionRejection,
      { status: [message] },
    );
  }

  if (edge.requiredFields.some((field) => !input[field]?.trim())) {
    const message = tr("work.err.ticket.resolutionRequired");
    throw new TransitionError(
      {
        entity: "ticket",
        currentState: current.status,
        attemptedTarget: input.status,
        ...ticketActionMetadata(current.status),
        reason: { code: "RESOLUTION_REQUIRED", message },
      } satisfies TicketTransitionRejection,
      { resolution: [message] },
    );
  }

  validateKnownFix({
    ...current,
    ...input,
    keepAsFix: edge.effect === "clearResolution" ? false : (input.keepAsFix ?? current.keepAsFix),
    resolution: input.resolution ?? current.resolution,
  });

  const ticket = await tx.ticket.update({
    where: { id },
    data: {
      status: input.status,
      ...(edge.effect === "resolve"
        ? {
            resolution: input.resolution!,
            resolvedAt: current.resolvedAt ?? new Date(),
            keepAsFix: input.keepAsFix ?? current.keepAsFix,
          }
        : edge.effect === "clearResolution"
          ? { resolution: null, resolvedAt: null, keepAsFix: false }
          : {}),
    },
  });

  await audit({
    action: edge.audit,
    entityType: "ticket",
    entityId: ticket.id,
    data: {
      from: current.status,
      to: input.status,
      ...(ticket.keepAsFix || current.keepAsFix ? { keepAsFix: ticket.keepAsFix } : {}),
    },
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
 * buttons use — identical transition table and audit verbs. IN_REVIEW has
 * no ticket status, so a drop there is refused; a drop in the ticket's current
 * lane is a no-op (no write, no audit); an illegal from→to pair is refused with
 * the transition message.
 */
export async function moveTicketToLane(
  actor: AuditActor,
  ticketId: string,
  lane: Lane,
  transition?: Pick<TicketTransitionInput, "resolution">,
): Promise<Ticket> {
  const status = TICKET_LANE_STATUS[lane];
  return txWithAudit(actor, async (tx, audit) => {
    await tx.$queryRaw`SELECT "id" FROM "Ticket" WHERE "id" = ${ticketId} FOR UPDATE`;
    const current = await tx.ticket.findUnique({ where: { id: ticketId } });
    if (!current) throw new NotFoundError(tr("work.err.ticket.notFound"));
    if (!status) {
      throw new TransitionError({
        entity: "ticket",
        currentState: current.status,
        attemptedTarget: lane,
        ...ticketActionMetadata(current.status),
        reason: { code: "UNSUPPORTED_LANE", message: tr("work.err.ticket.noReviewLane") },
      } satisfies TicketTransitionRejection);
    }
    if (laneOfTicketStatus(current.status) === lane) return current;
    return transitionTicketInTx(tx, audit, ticketId, { ...transition, status });
  });
}
