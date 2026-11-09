import { tr } from "~/i18n/request-locale.server";
import { Prisma } from "~/generated/prisma/client";
import type { TimeEntry } from "~/generated/prisma/client";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import type { Tx } from "~/lib/db.server";
import type { TimeEntryInput } from "./time.schema";

/**
 * Time-domain mutations. Every one runs through `txWithAudit`, so the
 * `ActivityLog` row commits with the change or not at all — entityType
 * `"timeEntry"` throughout. A refused mutation writes nothing.
 *
 * Ownership rule: members touch only their own entries (`userId === actor.id`);
 * admins may create/edit/delete for anyone. `TimeEntry.userId` is NOT NULL +
 * Restrict — GDPR pseudonymizes rather than deletes, so no FK action ever
 * fires.
 */

type TimeActor = AuditActor & { role?: string | null };

const isAdmin = (actor: TimeActor) => actor.role === "ADMIN";

async function requireEntry(tx: Tx, id: string): Promise<TimeEntry> {
  const entry = await tx.timeEntry.findUnique({ where: { id } });
  if (!entry) throw new NotFoundError(tr("work.err.timeEntry.notFound"));
  return entry;
}

async function requireTask(tx: Tx, id: string): Promise<void> {
  const task = await tx.task.findUnique({ where: { id }, select: { id: true } });
  if (!task) throw new ValidationError({ taskId: [tr("work.err.task.unknown")] });
}

function assertCanTouch(actor: TimeActor, entry: { userId: string }): void {
  if (actor.id !== entry.userId && !isAdmin(actor)) {
    throw new ValidationError({}, [tr("work.err.time.onlyOwnEntries")]);
  }
}

/** A P2002 on the one-running-timer partial index reads as a friendly refusal. */
function rethrowUnique(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
    throw new ValidationError({}, [tr("work.err.time.timerAlreadyRunning")]);
  }
  throw err;
}

const minutesOf = (e: { startsAt: Date; endsAt: Date | null }) =>
  e.endsAt ? Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 60_000) : null;

function assertRunningStart(input: TimeEntryInput): void {
  const now = new Date();
  if (input.endsAt === null && input.startsAt > now) {
    const message = tr("work.err.time.futureRunning");
    throw new ValidationError({ startsAt: [message] }, [message]);
  }
}

/**
 * Start the actor's timer. Refused while one is already running — the partial
 * unique index is the hard backstop, the pre-check is the friendly error.
 */
export async function startTimer(actor: TimeActor, taskId?: string | null): Promise<TimeEntry> {
  if (!actor.id) throw new ValidationError({}, [tr("work.err.time.timerRequired")]);
  return txWithAudit(actor, async (tx, audit) => {
    if (taskId) await requireTask(tx, taskId);
    const running = await tx.timeEntry.findFirst({ where: { userId: actor.id!, endsAt: null } });
    if (running) {
      throw new ValidationError({}, [tr("work.err.time.timerAlreadyRunning")]);
    }
    let entry: TimeEntry;
    try {
      entry = await tx.timeEntry.create({
        data: {
          userId: actor.id!,
          taskId: taskId ?? null,
          startsAt: new Date(),
          createdById: actor.id,
        },
      });
    } catch (e) {
      rethrowUnique(e);
    }
    await audit({
      action: "TimeEntryStarted",
      entityType: "timeEntry",
      entityId: entry!.id,
      data: { taskId: entry!.taskId, startsAt: entry!.startsAt.toISOString() },
    });
    return entry!;
  });
}

/** Stop the actor's running timer. Refused when nothing runs. */
export async function stopTimer(actor: TimeActor): Promise<TimeEntry> {
  if (!actor.id) throw new ValidationError({}, [tr("work.err.time.timerRequired")]);
  return txWithAudit(actor, async (tx, audit) => {
    const [running] = await tx.$queryRaw<TimeEntry[]>`
      SELECT * FROM "TimeEntry"
      WHERE "userId" = ${actor.id!} AND "endsAt" IS NULL
      FOR UPDATE
    `;
    if (!running) throw new ValidationError({}, [tr("work.err.time.noTimerRunning")]);
    const endsAt = new Date();
    if (running.startsAt >= endsAt) {
      const message = tr("work.err.time.futureTimerStop");
      throw new ValidationError({ startsAt: [message] }, [message]);
    }
    const entry = await tx.timeEntry.update({ where: { id: running.id }, data: { endsAt } });
    await audit({
      action: "TimeEntryStopped",
      entityType: "timeEntry",
      entityId: entry.id,
      data: { taskId: entry.taskId, minutes: minutesOf(entry) },
    });
    return entry;
  });
}

export async function createTimeEntry(actor: TimeActor, input: TimeEntryInput): Promise<TimeEntry> {
  if (!actor.id) throw new ValidationError({}, [tr("work.err.time.entryAuthorRequired")]);
  // Members log for themselves; only admins may file under someone else.
  const userId = isAdmin(actor) && input.userId ? input.userId : actor.id;
  return txWithAudit(actor, async (tx, audit) => {
    if (input.taskId) await requireTask(tx, input.taskId);
    if (userId !== actor.id) {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!user) throw new ValidationError({ userId: [tr("work.err.time.unknownUser")] });
    }
    assertRunningStart(input);
    let entry: TimeEntry;
    try {
      entry = await tx.timeEntry.create({
        data: {
          userId,
          taskId: input.taskId ?? null,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          comment: input.comment ?? null,
          createdById: actor.id,
        },
      });
    } catch (e) {
      rethrowUnique(e);
    }
    await audit({
      action: "TimeEntryCreated",
      entityType: "timeEntry",
      entityId: entry!.id,
      data: {
        userId: entry!.userId,
        taskId: entry!.taskId,
        startsAt: entry!.startsAt.toISOString(),
        endsAt: entry!.endsAt?.toISOString() ?? null,
        minutes: minutesOf(entry!),
      },
    });
    return entry!;
  });
}

export async function updateTimeEntry(
  actor: TimeActor,
  id: string,
  input: TimeEntryInput,
): Promise<TimeEntry> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await requireEntry(tx, id);
    assertCanTouch(actor, before);
    if (input.taskId) await requireTask(tx, input.taskId);

    const next = {
      taskId: input.taskId ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      comment: input.comment ?? null,
    };
    const changed =
      before.taskId !== next.taskId ||
      before.startsAt.getTime() !== next.startsAt.getTime() ||
      (before.endsAt?.getTime() ?? null) !== (next.endsAt?.getTime() ?? null) ||
      before.comment !== next.comment;
    if (!changed) return before; // no change → no write, no audit row

    assertRunningStart(input);
    let entry: TimeEntry;
    try {
      entry = await tx.timeEntry.update({ where: { id }, data: next });
    } catch (e) {
      rethrowUnique(e);
    }
    await audit({
      action: "TimeEntryUpdated",
      entityType: "timeEntry",
      entityId: entry!.id,
      data: {
        userId: entry!.userId,
        taskId: entry!.taskId,
        startsAt: entry!.startsAt.toISOString(),
        endsAt: entry!.endsAt?.toISOString() ?? null,
        minutes: minutesOf(entry!),
      },
    });
    return entry!;
  });
}

export async function deleteTimeEntry(actor: TimeActor, id: string): Promise<TimeEntry> {
  return txWithAudit(actor, async (tx, audit) => {
    const entry = await requireEntry(tx, id);
    assertCanTouch(actor, entry);
    await tx.timeEntry.delete({ where: { id } });
    await audit({
      action: "TimeEntryDeleted",
      entityType: "timeEntry",
      entityId: entry.id,
      data: {
        userId: entry.userId,
        taskId: entry.taskId,
        startsAt: entry.startsAt.toISOString(),
        endsAt: entry.endsAt?.toISOString() ?? null,
        minutes: minutesOf(entry),
      },
    });
    return entry;
  });
}
