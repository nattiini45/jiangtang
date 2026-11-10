import { tr } from "~/i18n/request-locale.server";
import { db, type Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { requirePermission } from "~/lib/rbac.server";
import { berlinDayIndex, berlinDayStartMs } from "~/lib/berlin-days";
import { NotFoundError } from "~/lib/errors.server";

export async function requireTimeAccess(
  actor: AuditActor,
  userId: string,
  edit = false,
  client: Tx = db,
) {
  if (!actor.id) throw new Response(tr("err.permissionRequired"), { status: 403 });
  if (actor.id !== userId)
    await requirePermission(actor, edit ? "time.editOthers" : "time.viewOthers", client);
}

export async function listTimeViewers(actor: AuditActor) {
  if (!actor.id) throw new Response(tr("err.permissionRequired"), { status: 403 });
  return db.user.findMany({
    where: {
      id: { not: actor.id },
      isActive: true,
      permissions: { some: { permission: { in: ["time.viewOthers", "time.editOthers"] } } },
    },
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

export async function recordTimesheetView(actor: AuditActor, userId: string, now = new Date()) {
  if (actor.id === userId) return;
  const day = berlinDayIndex(now);
  const from = new Date(berlinDayStartMs(day));
  const to = new Date(berlinDayStartMs(day + 1));
  return txWithAudit(actor, async (tx, audit) => {
    await requireTimeAccess(actor, userId, false, tx);
    if (!(await tx.user.findUnique({ where: { id: userId }, select: { id: true } })))
      throw new NotFoundError();
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`timesheet:${actor.id}:${userId}:${day}`}, 0))::text`;
    const exists = await tx.activityLog.findFirst({
      where: {
        action: "TimesheetViewed",
        actorId: actor.id,
        entityType: "user",
        entityId: userId,
        occurredAt: { gte: from, lt: to },
      },
      select: { id: true },
    });
    if (!exists)
      await audit({
        action: "TimesheetViewed",
        entityType: "user",
        entityId: userId,
        occurredAt: now,
      });
  });
}
