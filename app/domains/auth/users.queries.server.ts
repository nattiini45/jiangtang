import { randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { auth } from "~/lib/auth.server";
import { db, type Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { hasSqlState, NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { deleteResetLinks } from "~/domains/auth/password-reset.server";
import type { InviteInput, EditUserInput } from "~/domains/auth/users.schema";
import { UserRole } from "~/generated/prisma/enums";

/**
 * User/account management. All mutations go through `txWithAudit`
 * (audit in the same tx). Invite flow: an admin records a one-time invite token
 * in the `Verification` table; the invitee consumes it at `/accept-invite/:token`
 * to set their password, which creates the User and its Better Auth credential
 * Account in one transaction.
 *
 * Email/initials uniqueness is DB-enforced (User.email / User.initials @unique)
 * and checked up front so a clash is refused with a message instead of a 500.
 */

const INVITE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface UserListRow {
  id: string;
  email: string;
  name: string;
  initials: string | null;
  role: UserRole;
  isActive: boolean;
  /** Minutes per week; null = unset (renders „keine Kapazität"). */
  weeklyCapacityMinutes: number | null;
  emailVerified: boolean;
  createdAt: Date;
}

const USER_LIST_SELECT = {
  id: true,
  email: true,
  name: true,
  initials: true,
  role: true,
  isActive: true,
  weeklyCapacityMinutes: true,
  emailVerified: true,
  createdAt: true,
} as const;

export async function listUsers(): Promise<UserListRow[]> {
  const users = await db.user.findMany({
    orderBy: [{ createdAt: "asc" }],
    select: USER_LIST_SELECT,
  });
  return users;
}

export async function findUser(id: string): Promise<UserListRow> {
  const u = await db.user.findUnique({ where: { id }, select: USER_LIST_SELECT });
  if (!u) throw new NotFoundError(tr("places.err.user.notFound"));
  return u;
}

/** Create an invite: a pending token in Verification. Returns the token. */
export async function createInvite(input: InviteInput, actor: AuditActor): Promise<string> {
  const token = randomBytes(24).toString("hex");
  // Better Auth stores and signs in with lower-cased emails, so the invite does too.
  input = {
    ...input,
    email: input.email.trim().toLowerCase(),
    initials: input.initials.toUpperCase(),
  };
  await txWithAudit(actor, async (tx, audit) => {
    const clash = await findInviteClash(tx, input.email, input.initials);
    if (clash === "email") {
      throw new ValidationError({ email: [tr("places.err.invite.emailTaken")] });
    }
    if (clash === "initials") {
      throw new ValidationError({
        initials: [tr("places.err.invite.initialsTaken", { initials: input.initials })],
      });
    }

    // Supersede any still-pending invite(s) for this email first, so
    // re-inviting someone can't leave multiple valid tokens/roles coexisting —
    // only the newest invite should ever be resolvable.
    // Case-insensitive: invites created before emails were lower-cased kept the
    // email as typed.
    await tx.verification.deleteMany({
      where: { identifier: { equals: input.email, mode: "insensitive" } },
    });

    // Token keyed by the invitee's email so /accept-invite can look it up. The
    // role/initials/name are stashed as JSON in `value` (alongside the token)
    // since Verification is the only Better Auth table for opaque tokens.
    const payload = JSON.stringify({
      token,
      email: input.email,
      name: input.name,
      initials: input.initials,
      role: input.role,
    });
    await tx.verification.create({
      data: {
        identifier: input.email,
        value: payload,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await audit({
      action: "UserInvited",
      entityType: "user",
      entityId: input.email,
      data: {
        email: input.email,
        name: input.name,
        role: input.role,
      } as unknown as import("~/generated/prisma/client").Prisma.InputJsonValue,
    });
  });
  return token;
}

export interface InviteRecord {
  token: string;
  email: string;
  name: string;
  initials: string;
  role: UserRole;
}

/** Look up + validate an invite token by its token (extracted from the URL). */
export async function resolveInvite(token: string): Promise<InviteRecord> {
  // The token lives inside the JSON `value`; scan by identifier==email isn't
  // possible without the email, so pre-filter on the token field across rows.
  // This is an unindexed substring scan, but it's anchored on the literal
  // `"token":"<value>"` key/value pair (not a bare substring match), so a
  // candidate can only be pulled in by an actual token value containing ours
  // as a substring — not by an unrelated field. The JSON.parse + exact
  // `parsed.token === token` check below is what actually decides a match; this
  // is purely a cheap pre-filter to avoid parsing every row. A real fix (exact
  // lookup) would need a dedicated indexed token column.
  const candidates = await db.verification.findMany({
    where: { value: { contains: `"token":"${token}"` } },
  });
  for (const row of candidates) {
    if (row.expiresAt <= new Date()) continue;
    try {
      const parsed = JSON.parse(row.value) as Partial<InviteRecord> & { token: string };
      if (parsed.token === token) {
        return {
          token,
          email: parsed.email ?? row.identifier,
          name: parsed.name ?? "",
          initials: parsed.initials ?? "",
          role: (parsed.role ?? "MEMBER") as UserRole,
        };
      }
    } catch {
      continue;
    }
  }
  throw new NotFoundError(tr("places.err.invite.notFound"));
}

/**
 * Which unique User field an invitee would collide with, if any. Emails are
 * compared case-insensitively because Better Auth lower-cases them at sign-in.
 */
async function findInviteClash(
  tx: Tx,
  email: string,
  initials: string,
): Promise<"email" | "initials" | null> {
  const byEmail = await tx.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (byEmail) return "email";
  const byInitials = await tx.user.findFirst({ where: { initials }, select: { id: true } });
  return byInitials ? "initials" : null;
}

function acceptClashError(clash: "email" | "initials", invite: InviteRecord): ValidationError {
  return new ValidationError({}, [
    clash === "email"
      ? tr("places.err.invite.acceptEmailTaken")
      : tr("places.err.invite.acceptInitialsTaken", { initials: invite.initials }),
  ]);
}

/**
 * Consume an invite: create the user with the admin-chosen role and initials,
 * its Better Auth credential, consume the invite and write the audit row, all in
 * one transaction. Better Auth's `signUpEmail` is not used because it commits the
 * user on its own, so a later failure (an initials clash) would leave an orphan
 * account that can sign in. The password is hashed with Better Auth's own
 * function and stored the way its email/password sign-in reads it.
 *
 * A clash with an existing email or initials throws a ValidationError with a
 * form-level message and creates nothing; the invite stays valid.
 */
export async function acceptInvite(
  invite: InviteRecord,
  password: string,
): Promise<{ id: string; email: string }> {
  const email = invite.email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  // No session exists at acceptance time (the public /accept-invite route), so
  // the new user is the audit actor. Its id is only known once the row exists;
  // `audit` reads the actor when it is called, after the id is filled in below.
  const selfActor: AuditActor = { name: invite.name, email, initials: invite.initials };

  try {
    return await txWithAudit(selfActor, async (tx, audit) => {
      const clash = await findInviteClash(tx, email, invite.initials);
      if (clash) throw acceptClashError(clash, invite);

      const user = await tx.user.create({
        data: {
          email,
          name: invite.name,
          role: invite.role,
          initials: invite.initials,
          emailVerified: true,
        },
      });
      await tx.account.create({
        data: {
          userId: user.id,
          accountId: user.id,
          providerId: "credential",
          password: passwordHash,
        },
      });
      selfActor.id = user.id;

      // Single-use: delete any invite rows for this email/token.
      await tx.verification.deleteMany({
        where: {
          OR: [
            { identifier: { equals: email, mode: "insensitive" } },
            { value: { contains: `"token":"${invite.token}"` } },
          ],
        },
      });

      await audit({
        action: "InviteAccepted",
        entityType: "user",
        entityId: user.id,
        data: { role: invite.role, initials: invite.initials },
      });
      return { id: user.id, email: user.email };
    });
  } catch (e) {
    // A concurrent invite acceptance or rename can still win between the check
    // and the insert; the unique index then decides, with the same message.
    if (hasSqlState(e, "P2002") || hasSqlState(e, "23505")) {
      const clash = await findInviteClash(db, email, invite.initials);
      throw acceptClashError(clash ?? "email", invite);
    }
    throw e;
  }
}

/**
 * Last-admin / self-demotion lockout guard. Throws a ValidationError if
 * applying `next` to `targetUserId` would either:
 *   - demote/deactivate the sole remaining active ADMIN, or
 *   - let an admin demote/deactivate THEMSELVES (even if other admins exist —
 *     self-service admin status changes are blocked outright).
 * Must run inside the same tx as the write. The active-admin set is locked with
 * `SELECT … FOR UPDATE` (not a plain COUNT): under the default READ COMMITTED
 * isolation a bare count is subject to write-skew — two concurrent transactions
 * each demoting one of the last two admins would both read "1 other admin" and
 * both commit, leaving zero active admins (a permanent lockout). The row lock
 * serializes such transactions so the second one re-evaluates against the first's
 * committed result and is correctly rejected.
 */
export async function assertCanChangeAdminStatus(
  tx: Tx,
  targetUserId: string,
  actor: AuditActor,
  next: { role?: UserRole; isActive?: boolean },
): Promise<void> {
  const target = await tx.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new NotFoundError(tr("places.err.user.notFound"));

  const isCurrentlyActiveAdmin = target.role === "ADMIN" && target.isActive;
  if (!isCurrentlyActiveAdmin) return;

  const willDemote = next.role !== undefined && next.role !== "ADMIN";
  const willDeactivate = next.isActive !== undefined && next.isActive === false;
  if (!willDemote && !willDeactivate) return;

  // Self-service: an admin may never demote/deactivate themselves this way,
  // regardless of how many other admins exist.
  if (actor.id && actor.id === targetUserId) {
    throw new ValidationError({}, [tr("places.err.user.lastAdmin")]);
  }

  // Lock the current active-admin rows for the duration of this tx so a
  // concurrent last-admin demotion blocks here and re-checks after we commit,
  // instead of racing us to zero (see the write-skew note in the doc comment).
  const activeAdmins = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "User" WHERE role = 'ADMIN' AND "isActive" = true FOR UPDATE
  `;
  const otherActiveAdmins = activeAdmins.filter((a) => a.id !== targetUserId).length;
  if (otherActiveAdmins === 0) {
    throw new ValidationError({}, [tr("places.err.user.lastAdmin")]);
  }
}

export async function updateUser(
  id: string,
  input: EditUserInput,
  actor: AuditActor,
): Promise<void> {
  await txWithAudit(actor, async (tx, audit) => {
    const before = await tx.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("places.err.user.notFound"));
    await assertCanChangeAdminStatus(tx, id, actor, {
      role: input.role,
      isActive: input.isActive,
    });
    // Hours per week → stored minutes; null = capacity unset.
    const capacityMinutes =
      input.weeklyCapacityHours == null ? null : Math.round(input.weeklyCapacityHours * 60);
    await tx.user.update({
      where: { id },
      data: {
        role: input.role,
        initials: input.initials.toUpperCase(),
        isActive: input.isActive,
        weeklyCapacityMinutes: capacityMinutes,
      },
    });
    // A link issued before the deactivation must not work again after a
    // reactivation.
    if (input.isActive === false) await deleteResetLinks(tx, id);
    await audit({
      action: "UserUpdated",
      entityType: "user",
      entityId: id,
      data: {
        before: {
          role: before.role,
          initials: before.initials,
          isActive: before.isActive,
          weeklyCapacityMinutes: before.weeklyCapacityMinutes,
        },
        after: {
          role: input.role,
          initials: input.initials,
          isActive: input.isActive,
          weeklyCapacityMinutes: capacityMinutes,
        },
      } as unknown as import("~/generated/prisma/client").Prisma.InputJsonValue,
    });
  });
  // Sessions are owned by Better Auth, so they are revoked through its internal
  // adapter, after the change has committed. A failure here leaves the account
  // inactive, and requireUser already refuses inactive users.
  if (input.isActive === false) {
    const { internalAdapter } = await auth.$context;
    await internalAdapter.deleteUserSessions(id);
  }
}
