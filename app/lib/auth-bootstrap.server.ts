import { verifyPassword } from "better-auth/crypto";
import { readConfig } from "~/lib/config.server";
import { auth } from "~/lib/auth.server";
import { txWithAudit } from "~/lib/audit.server";
import { db } from "~/lib/db.server";

/**
 * Production first-admin bootstrap. A fresh deploy has no users, yet every
 * user-management route is requireRole("ADMIN") — a chicken-and-egg lock. This
 * seeds an ADMIN from ADMIN_EMAIL / ADMIN_PASSWORD (+ optional ADMIN_INITIALS)
 * so an operator can sign in and invite the rest.
 *
 * It acts only when no active ADMIN exists: on a fresh install, or to recover
 * from a full lockout. While any active admin exists it logs and skips, so an
 * account that an admin demoted or deactivated is never re-elevated on a later
 * boot. Unset ADMIN_EMAIL / ADMIN_PASSWORD is a silent no-op in every environment.
 * Creating the account goes through Better Auth signUpEmail (which hashes the
 * password); the domain fields are then set in an audited transaction. Recovering
 * an existing account promotes it only when ADMIN_PASSWORD is that account's own
 * password, so a rotated or foreign password never silently re-elevates it.
 */

export interface FirstAdminBootstrapDeps {
  /** True when at least one active ADMIN exists. Injectable so tests can cover an
   *  empty admin set without changing rows that other suites share. */
  activeAdminExists(): Promise<boolean>;
}

const databaseDeps: FirstAdminBootstrapDeps = {
  activeAdminExists: async () =>
    (await db.user.findFirst({
      where: { role: "ADMIN", isActive: true },
      select: { id: true },
    })) !== null,
};

export async function bootstrapFirstAdmin(
  deps: FirstAdminBootstrapDeps = databaseDeps,
): Promise<void> {
  const email = readConfig("ADMIN_EMAIL");
  const password = readConfig("ADMIN_PASSWORD");

  if (!email || !password) {
    if (readConfig("NODE_ENV") === "production") {
      console.log("[auth] ADMIN_EMAIL/ADMIN_PASSWORD not set — first-admin bootstrap skipped");
    }
    return;
  }

  try {
    if (await deps.activeAdminExists()) {
      console.log("[auth] an active admin exists — first-admin bootstrap skipped");
      return;
    }

    const initials = resolveInitials(readConfig("ADMIN_INITIALS"), email);

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      // Recovery: the account exists but no active admin does (for example a
      // previous boot's promote step failed after signUpEmail succeeded). The
      // operator must prove control of the account with its own password; a
      // stale or foreign ADMIN_PASSWORD leaves the account untouched.
      const credential = await db.account.findFirst({
        where: { userId: existing.id, providerId: "credential" },
        select: { password: true },
      });
      if (!credential?.password) {
        console.error(
          `[auth] first-admin recovery refused: ${email} has no password credential; no change made`,
        );
        return;
      }
      if (!(await verifyPassword({ hash: credential.password, password }))) {
        console.error(
          `[auth] first-admin recovery refused: ADMIN_PASSWORD does not match ${email}; no change made`,
        );
        return;
      }
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
 * `@unique`: when another account already holds them, the promotion still goes
 * through without them (the operator can pick unique initials in the admin UI
 * later). Losing initials must never cost the deployment its only admin.
 */
const SYSTEM_ACTOR = { name: "system" } as const;

async function promoteToAdmin(id: string, initials: string): Promise<void> {
  const data = { role: "ADMIN" as const, emailVerified: true, isActive: true };
  // Domain-field writes carry an audit row like every other mutation:
  // the bootstrap path runs unattended at boot, so the ActivityLog row is the
  // only durable record that an admin was provisioned.
  await txWithAudit(SYSTEM_ACTOR, async (tx, audit) => {
    // Checked before the write rather than caught afterwards: a unique violation
    // aborts the PostgreSQL transaction, so a retry inside it would fail as well.
    const clash = await tx.user.findFirst({
      where: { initials, id: { not: id } },
      select: { id: true },
    });
    await tx.user.update({ where: { id }, data: clash ? data : { ...data, initials } });
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
