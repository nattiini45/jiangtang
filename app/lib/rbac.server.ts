import type { AuthUser, AppRole } from "~/lib/auth.server";

/**
 * Role-based access control. A small permissions matrix over the two
 * frozen roles (ADMIN / MEMBER). Both roles can do the day-to-day AV work; ADMIN
 * additionally manages accounts. `requirePermission` layers on the frozen
 * `requireUser` (so it still redirects anonymous users and blocks deactivated
 * ones) and throws 403 for an under-privileged signed-in user.
 *
 * Kept deliberately coarse (just admin/member) — a verb set is easy to widen later without changing
 * call sites (`can(user, verb)`).
 */

export type Permission =
  // Account management — admin only.
  | "user.invite"
  | "user.manage"
  // Day-to-day work — any active member.
  | "room.edit"
  | "equipment.edit"
  | "ticket.edit"
  | "event.edit";

const ADMIN_ONLY: ReadonlySet<Permission> = new Set<Permission>(["user.invite", "user.manage"]);

/** Does this user have `perm`? */
export function can(user: AuthUser, perm: Permission): boolean {
  // Deactivated users are blocked at requireUser; belt-and-braces here too.
  if (user.isActive === false) return false;
  if (ADMIN_ONLY.has(perm)) return user.role === "ADMIN";
  return true; // MEMBER + ADMIN both do day-to-day work
}

/** Resolve the role required for a permission (for diagnostics/UI hints). */
export function roleRequiredFor(perm: Permission): AppRole {
  return ADMIN_ONLY.has(perm) ? "ADMIN" : "MEMBER";
}
