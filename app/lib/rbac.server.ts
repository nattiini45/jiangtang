import { tr } from "~/i18n/request-locale.server";
import type { AuthUser, AppRole } from "~/lib/auth.server";
import { db, type Tx } from "~/lib/db.server";
import type { AuditActor } from "~/lib/audit.server";

/**
 * Role-based access control: a small permission matrix over the two roles
 * (ADMIN / MEMBER). Both roles can do the day-to-day AV work; ADMIN additionally
 * manages accounts. This module only answers whether a user may do something
 * (`can`, `roleRequiredFor`). The route guards live in `auth.server.ts`:
 * `requireUser` redirects anonymous and deactivated users, and `requireRole`
 * throws 403 for an under-privileged signed-in user.
 *
 * Kept deliberately coarse (admin and member only). A verb set is easy to widen
 * later without changing call sites (`can(user, verb)`).
 */

export type Permission =
  // Account management — admin only.
  | "user.invite"
  | "user.manage"
  | "time.viewOthers"
  | "time.editOthers"
  | "audit.view"
  // Day-to-day work — any active member.
  | "room.edit"
  | "equipment.edit"
  | "ticket.edit"
  | "event.edit";

const ADMIN_ONLY: ReadonlySet<Permission> = new Set<Permission>([
  "user.invite",
  "user.manage",
  "audit.view",
]);

/** Does this user have `perm`? */
export function can(
  user: Pick<AuthUser, "role" | "isActive"> & { permissions?: string[] },
  perm: Permission,
): boolean {
  // Deactivated users are blocked at requireUser; belt-and-braces here too.
  if (user.isActive === false) return false;
  if (perm === "time.viewOthers")
    return user.permissions?.some((p) => p === perm || p === "time.editOthers") ?? false;
  if (perm === "time.editOthers") return user.permissions?.includes(perm) ?? false;
  if (ADMIN_ONLY.has(perm)) return user.role === "ADMIN";
  return true; // MEMBER + ADMIN both do day-to-day work
}

export async function hasPermission(
  actor: AuditActor,
  perm: Permission,
  client: Tx = db,
): Promise<boolean> {
  if (!actor.id) return false;
  const user = await client.user.findUnique({
    where: { id: actor.id },
    include: { permissions: true },
  });
  return user
    ? can({ ...user, permissions: user.permissions.map((p) => p.permission) }, perm)
    : false;
}

export async function requirePermission(
  actor: AuditActor,
  perm: Permission,
  client: Tx = db,
): Promise<void> {
  if (!(await hasPermission(actor, perm, client)))
    throw new Response(tr("err.permissionRequired"), { status: 403 });
}

/** Resolve the role required for a permission (for diagnostics/UI hints). */
export function roleRequiredFor(perm: Permission): AppRole {
  return ADMIN_ONLY.has(perm) ? "ADMIN" : "MEMBER";
}
