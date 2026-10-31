import { auth } from "~/lib/auth.server";
import { txWithAudit } from "~/lib/audit.server";
import { db } from "~/lib/db.server";

/**
 * Production first-admin bootstrap. A fresh prod deploy has no users, yet every
 * user-management route is requireRole("ADMIN") — a chicken-and-egg lock. This
 * seeds the first ADMIN from ADMIN_EMAIL / ADMIN_PASSWORD (+ optional
 * ADMIN_INITIALS) so an operator can sign in and invite the rest.
 *
 * Self-gating on env, so calling it in every environment is safe: with no
 * ADMIN_EMAIL/ADMIN_PASSWORD it returns silently. Idempotent AND self-healing:
 * if the admin email exists but is not a fully-provisioned ADMIN (a previous
 * boot's promote step failed after signUpEmail succeeded), the promote is
 * re-applied — otherwise the account would be stuck as MEMBER forever with no
 * in-app path to fix it. Mirrors the dev-seed mechanic — Better Auth
 * signUpEmail (hashes the password) then a db.user.update for our domain fields.
 */
export async function bootstrapFirstAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    if (process.env.NODE_ENV === "production") {
      console.log("[auth] ADMIN_EMAIL/ADMIN_PASSWORD not set — first-admin bootstrap skipped");
    }
    return;
  }

  try {
    const initials = resolveInitials(process.env.ADMIN_INITIALS, email);

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.role === "ADMIN" && existing.isActive && existing.emailVerified) return;
      await promoteToAdmin(existing.id, initials);
      console.log(`[auth] first admin re-provisioned: ${email}`);
      return;
    }

    const { user } = await auth.api.signUpEmail({
      body: { email, password, name: "Administrator" },
    });
    await promoteToAdmin(user.id, initials);
    console.log(`[auth] first admin bootstrapped: ${email}`);
  } catch (error) {
    console.error("[auth] first-admin bootstrap failed:", (error as Error).message);
  }
}

/**
 * Set the domain fields that make the account a usable admin. `initials` is
 * `@unique` — on a collision (P2002) the promotion still goes through without
 * them (the operator can pick unique initials in the admin UI later); losing
 * initials must never cost the deployment its only admin.
 */
const SYSTEM_ACTOR = { name: "system" } as const;

async function promoteToAdmin(id: string, initials: string): Promise<void> {
  const data = { role: "ADMIN" as const, emailVerified: true, isActive: true };
  // Domain-field writes carry an audit row like every other mutation:
  // the bootstrap path runs unattended at boot, so the ActivityLog row is the
  // only durable record that an admin was provisioned.
  await txWithAudit(SYSTEM_ACTOR, async (tx, audit) => {
    try {
      await tx.user.update({ where: { id }, data: { ...data, initials } });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        await tx.user.update({ where: { id }, data });
      } else {
        throw error;
      }
    }
    await audit({
      action: "UserBootstrapped",
      entityType: "user",
      entityId: id,
    });
  });
}

/**
 * Explicit ADMIN_INITIALS if given, else derive from the email local part:
 * alphanumerics only, uppercased, capped at 3 chars. Falls back to "AD" if the
 * local part yields nothing usable.
 */
function resolveInitials(raw: string | undefined, email: string): string {
  const explicit = raw?.trim();
  if (explicit) return explicit.toUpperCase().slice(0, 3);

  const local = email.split("@")[0] ?? "";
  const derived = local
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, 3);
  return derived || "AD";
}
