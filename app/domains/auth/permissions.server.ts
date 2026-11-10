import { db } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { requirePermission } from "~/lib/rbac.server";
import { NotFoundError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { TIME_PERMISSIONS, timePermissionSchema } from "./permissions.schema";

export async function listUserPermissions(actor: AuditActor, userId: string) {
  await requirePermission(actor, "user.manage");
  return db.userPermission.findMany({
    where: { userId, permission: { in: [...TIME_PERMISSIONS] } },
  });
}

export async function setTimePermission(
  actor: AuditActor,
  userId: string,
  permission: string,
  enabled: boolean,
) {
  const verb = timePermissionSchema.parse(permission);
  if (actor.via) throw new Response(tr("err.permissionRequired"), { status: 403 });
  return txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "user.manage", tx);
    const [user] = await tx.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    if (!user) throw new NotFoundError();
    const where = { userId_permission: { userId, permission: verb } };
    const before = await tx.userPermission.findUnique({ where });
    if (Boolean(before) === enabled) return;
    if (enabled) await tx.userPermission.create({ data: { userId, permission: verb } });
    else await tx.userPermission.delete({ where });
    await audit({
      action: enabled ? "UserPermissionGranted" : "UserPermissionRevoked",
      entityType: "user",
      entityId: userId,
      data: { permission: verb },
    });
  });
}
