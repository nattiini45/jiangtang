import { tr } from "~/i18n/request-locale.server";
import { db, type Tx } from "~/lib/db.server";
import type { AuditActor } from "~/lib/audit.server";
import { requirePermission } from "~/lib/rbac.server";

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
