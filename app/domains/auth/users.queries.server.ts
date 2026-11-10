import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { auth } from "~/lib/auth.server";
import { db, type Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { hasSqlState, NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { deleteResetLinks } from "~/domains/auth/password-reset.server";
import { revokeUserPersonalAccessTokens } from "~/domains/api-tokens/api-tokens.lifecycle.server";
import type { InviteInput, EditUserInput } from "~/domains/auth/users.schema";
import { UserRole } from "~/generated/prisma/enums";
import { emitChange } from "~/lib/realtime/emit.server";
import { ENTITY_TYPE } from "~/domains/tickets/tickets.history.server";

/**
 * User/account management. All mutations go through `txWithAudit`
 * (audit in the same tx). Invite flow: an admin records a hashed one-time token;
 * the invitee consumes it at `/accept-invite/:token`
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
  twoFactorEnabled: boolean;
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
  twoFactorEnabled: true,
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

export type InvitationState = "pending" | "accepted" | "expired" | "revoked";

export function invitationState(row: {
  acceptedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
}): InvitationState {
  if (row.acceptedAt) return "accepted";
  if (row.revokedAt) return "revoked";
  return row.expiresAt <= new Date() ? "expired" : "pending";
}

export async function listInvitations() {
  const rows = await db.invitation.findMany({
    orderBy: { createdAt: "desc" },
    omit: { tokenHash: true },
    include: { invitedBy: { select: { name: true, email: true } } },
  });
  return rows.map((row) => ({ ...row, state: invitationState(row) }));
}

function inviteHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createInvite(input: InviteInput, actor: AuditActor): Promise<string> {
  const token = randomBytes(24).toString("hex");
  input = {
    ...input,
    email: input.email.trim().toLowerCase(),
    initials: input.initials.toUpperCase(),
  };
  await txWithAudit(actor, async (tx, audit) => {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${input.email}, 0))`;
    const clash = await findInviteClash(tx, input.email, input.initials);
    if (clash === "email")
      throw new ValidationError({ email: [tr("places.err.invite.emailTaken")] });
    if (clash === "initials") {
      throw new ValidationError({
        initials: [tr("places.err.invite.initialsTaken", { initials: input.initials })],
      });
    }
    await tx.invitation.updateMany({
      where: { email: input.email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date(), tokenHash: null },
    });
    await tx.verification.deleteMany({
      where: { identifier: { equals: input.email, mode: "insensitive" } },
    });
    const inviter = actor.id
      ? await tx.user.findUnique({ where: { id: actor.id }, select: { id: true } })
      : null;
    const row = await tx.invitation.create({
      data: {
        ...input,
        tokenHash: inviteHash(token),
        invitedById: inviter?.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await audit({
      action: "UserInvited",
      entityType: "user",
      entityId: input.email,
      data: { invitationId: row.id, email: input.email, name: input.name, role: input.role },
    });
  });
  return token;
}

export async function changeInvitation(
  id: string,
  intent: "revoke" | "reissue",
  actor: AuditActor,
) {
  const token = intent === "reissue" ? randomBytes(24).toString("hex") : null;
  await txWithAudit(actor, async (tx, audit) => {
    await tx.$queryRaw`SELECT id FROM "Invitation" WHERE id = ${id} FOR UPDATE`;
    const row = await tx.invitation.findUnique({ where: { id } });
    if (!row) throw new NotFoundError(tr("places.err.invite.notFound"));
    const state = invitationState(row);
    if (state !== "pending" && !(intent === "reissue" && state === "expired")) {
      throw new ValidationError({}, [tr("admin.invitations.changed")]);
    }
    await tx.invitation.update({
      where: { id },
      data: token
        ? { tokenHash: inviteHash(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) }
        : { tokenHash: null, revokedAt: new Date() },
    });
    await tx.verification.deleteMany({ where: { id } });
    await audit({
      action: token ? "InvitationReissued" : "InvitationRevoked",
      entityType: "user",
      entityId: row.email,
      data: { invitationId: id },
    });
  });
  return token;
}

export interface InviteRecord {
  id: string;
  token: string;
  email: string;
  name: string;
  initials: string;
  role: UserRole;
}

async function findInvite(tx: Tx, token: string): Promise<InviteRecord> {
  const row = await tx.invitation.findUnique({ where: { tokenHash: inviteHash(token) } });
  if (!row || invitationState(row) !== "pending") {
    throw new NotFoundError(tr("places.err.invite.notFound"));
  }
  return {
    id: row.id,
    token,
    email: row.email,
    name: row.name,
    initials: row.initials,
    role: row.role,
  };
}

export async function resolveInvite(token: string): Promise<InviteRecord> {
  return findInvite(db, token);
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
  invite = await resolveInvite(invite.token);
  const email = invite.email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  // No session exists at acceptance time (the public /accept-invite route), so
  // the new user is the audit actor. Its id is only known once the row exists;
  // `audit` reads the actor when it is called, after the id is filled in below.
  const selfActor: AuditActor = { name: invite.name, email, initials: invite.initials };

  try {
    return await txWithAudit(selfActor, async (tx, audit) => {
      await tx.$queryRaw`SELECT id FROM "Invitation" WHERE id = ${invite.id} FOR UPDATE`;
      invite = await findInvite(tx, invite.token);
      const clash = await findInviteClash(tx, email, invite.initials);
      if (clash) throw acceptClashError(clash, invite);

      const user = await tx.user.create({
        data: {
          email,
          name: invite.name,
          role: invite.role,
          initials: invite.initials,
          emailVerified: false,
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

      await tx.invitation.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date(), tokenHash: null },
      });
      await tx.verification.deleteMany({ where: { id: invite.id } });
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
  const revokedTokenCount = await txWithAudit(actor, async (tx, audit) => {
    await assertCanChangeAdminStatus(tx, id, actor, {
      role: input.role,
      isActive: input.isActive,
    });
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${id} FOR UPDATE`;
    const before = await tx.user.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("places.err.user.notFound"));
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
    let revokedCount = 0;
    if (input.isActive === false) {
      await deleteResetLinks(tx, id);
      revokedCount = await revokeUserPersonalAccessTokens(tx, audit, id, "USER_DEACTIVATED");
    }
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
    return revokedCount;
  });
  if (revokedTokenCount > 0) {
    await emitChange({ entityType: ENTITY_TYPE.user, id, op: "updated" });
  }
  // Sessions are owned by Better Auth, so they are revoked through its internal
  // adapter, after the change has committed. A failure here leaves the account
  // inactive, and requireUser already refuses inactive users.
  if (input.isActive === false) {
    const { internalAdapter } = await auth.$context;
    await internalAdapter.deleteUserSessions(id);
  }
}
