import type { Prisma } from "~/generated/prisma/client";
import { NotificationType } from "~/generated/prisma/enums";
import { db, type Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { NotFoundError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";

/**
 * Inbox writes. `createNotificationInTx` joins the triggering mutation's
 * transaction (task assignment); `notifyUsers` is the standalone funnel for
 * the sweep jobs and the booking-conflict follow-up, emitting one realtime
 * event per row so open shells refetch their badge and inbox.
 *
 * Notifications are system-generated side effects, not user mutations, so
 * they carry no ActivityLog row — `txWithAudit` is used purely as the
 * sanctioned transaction wrapper.
 */
export interface NotificationInput {
  userId: string;
  type: NotificationType;
  entityType?: string | null;
  entityId?: string | null;
  data?: Prisma.InputJsonValue;
}

export async function createNotificationInTx(tx: Tx, input: NotificationInput) {
  return tx.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      data: input.data ?? undefined,
    },
  });
}

/** Notify several users in one transaction; returns the created rows. */
export async function notifyUsers(
  actor: AuditActor | null,
  inputs: NotificationInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  const created = await txWithAudit(actor, async (tx) => {
    const rows = [];
    for (const input of inputs) rows.push(await createNotificationInTx(tx, input));
    return rows;
  });
  for (const row of created) {
    await emitChange({ entityType: "notification", id: row.id, op: "created" });
  }
  return created.length;
}

/** TASK_ASSIGNED for newly added assignees, inside the task's own transaction. */
export async function notifyTaskAssignedInTx(
  tx: Tx,
  task: { id: string; title: string },
  addedUserIds: string[],
  actorId?: string | null,
) {
  for (const userId of addedUserIds) {
    if (actorId && userId === actorId) continue; // self-assignment is not news
    await createNotificationInTx(tx, {
      userId,
      type: NotificationType.TASK_ASSIGNED,
      entityType: "task",
      entityId: task.id,
      data: { title: task.title },
    });
  }
}

export async function markNotificationRead(actor: AuditActor, id: string) {
  const updated = await txWithAudit(actor, async (tx) => {
    const row = await tx.notification.findUnique({ where: { id } });
    if (!row || row.userId !== actor.id) {
      throw new NotFoundError(tr("err.notFoundBody"));
    }
    return tx.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  });
  // Realtime so other open tabs' bell badges refresh too.
  await emitChange({ entityType: "notification", id: updated.id, op: "updated" });
  return updated;
}

export async function markAllNotificationsRead(actor: AuditActor): Promise<number> {
  if (!actor.id) return 0;
  const result = await txWithAudit(actor, async (tx) =>
    tx.notification.updateMany({
      where: { userId: actor.id!, readAt: null },
      data: { readAt: new Date() },
    }),
  );
  if (result.count > 0) {
    await emitChange({ entityType: "notification", id: actor.id, op: "updated" });
  }
  return result.count;
}

export async function pruneReadNotifications(cutoff: Date): Promise<number> {
  return (await db.notification.deleteMany({ where: { readAt: { lt: cutoff } } })).count;
}

/**
 * Due-soon sweep: every open task whose `dueAt` falls within the horizon gets
 * one TASK_DUE_SOON notification per assignee — deduplicated by
 * (user, type, entity) so the hourly tick never spams. Runs from the boot job.
 */
export async function sweepDueSoon(opts: { horizonHours?: number } = {}): Promise<number> {
  const horizonHours = opts.horizonHours ?? 48;
  const horizon = new Date(Date.now() + horizonHours * 60 * 60 * 1000);
  const tasks = await db.task.findMany({
    where: {
      dueAt: { not: null, lte: horizon, gte: new Date() },
      status: { notIn: ["DONE", "CANCELLED"] },
      assignees: { some: {} },
    },
    select: {
      id: true,
      title: true,
      dueAt: true,
      assignees: { select: { userId: true } },
    },
  });
  const inputs: NotificationInput[] = [];
  for (const task of tasks) {
    for (const a of task.assignees) {
      const existing = await db.notification.findFirst({
        where: {
          userId: a.userId,
          type: NotificationType.TASK_DUE_SOON,
          entityType: "task",
          entityId: task.id,
        },
        select: { id: true },
      });
      if (existing) continue;
      inputs.push({
        userId: a.userId,
        type: NotificationType.TASK_DUE_SOON,
        entityType: "task",
        entityId: task.id,
        data: { title: task.title, dueAt: task.dueAt!.toISOString() },
      });
    }
  }
  return notifyUsers(null, inputs);
}

/**
 * BOOKING_CONFLICT follow-up: the room/allocation insert hit the EXCLUDE
 * constraint, so the mutation rolled back. The person to tell is the
 * organizer of the *existing* conflicting booking — resolved by email/name
 * match on the event's free-text organizer; when that resolves to nobody,
 * active admins get the row instead.
 */
export async function notifyBookingConflict(input: {
  actor: AuditActor;
  entityType: "eventRoomBooking" | "equipmentAllocation";
  entityId: string | null;
  conflictingEventIds: string[];
  detail: Prisma.InputJsonValue;
}): Promise<number> {
  const organizers = await db.event.findMany({
    where: { id: { in: input.conflictingEventIds } },
    select: { id: true, title: true, organizer: true },
  });
  const recipients = new Set<string>();
  for (const ev of organizers) {
    if (!ev.organizer) continue;
    const user = await db.user.findFirst({
      where: { isActive: true, OR: [{ email: ev.organizer }, { name: ev.organizer }] },
      select: { id: true },
    });
    if (user) recipients.add(user.id);
  }
  if (recipients.size === 0) {
    const admins = await db.user.findMany({
      where: { isActive: true, role: "ADMIN" },
      select: { id: true },
    });
    for (const a of admins) recipients.add(a.id);
  }
  const inputs: NotificationInput[] = [...recipients].map((userId) => ({
    userId,
    type: NotificationType.BOOKING_CONFLICT,
    // Link to the conflicting event (the recipient's own booking), not the
    // booking sub-row — `entityHref` has no target for those.
    entityType: "event",
    entityId: input.conflictingEventIds[0] ?? input.entityId,
    data: input.detail,
  }));
  return notifyUsers(input.actor, inputs);
}

/**
 * Warranty-expiry notifications for the sweep: one WARRANTY_EXPIRING per
 * expiring item per active admin, deduplicated by (admin, type, item).
 */
export async function notifyWarrantyExpiring(
  items: { id: string; name: string; warrantyExpiresAt: Date }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const admins = await db.user.findMany({
    where: { isActive: true, role: "ADMIN" },
    select: { id: true },
  });
  const inputs: NotificationInput[] = [];
  for (const item of items) {
    for (const admin of admins) {
      const existing = await db.notification.findFirst({
        where: {
          userId: admin.id,
          type: NotificationType.WARRANTY_EXPIRING,
          entityType: "inventory-item",
          entityId: item.id,
        },
        select: { id: true },
      });
      if (existing) continue;
      inputs.push({
        userId: admin.id,
        type: NotificationType.WARRANTY_EXPIRING,
        entityType: "inventory-item",
        entityId: item.id,
        data: {
          name: item.name,
          warrantyExpiresAt: item.warrantyExpiresAt.toISOString(),
        },
      });
    }
  }
  return notifyUsers(null, inputs);
}
