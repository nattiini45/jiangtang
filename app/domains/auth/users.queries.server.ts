import { randomBytes } from "node:crypto";
import { auth } from "~/lib/auth.server";
import { db, type Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import type { InviteInput, EditUserInput } from "~/domains/auth/users.schema";
import { UserRole } from "~/generated/prisma/enums";

/**
 * User/account management. All mutations go through `txWithAudit`
 * (audit in the same tx). Invite flow: an admin records a one-time invite token
 * in the `Verification` table; the invitee consumes it at `/accept-invite/:token`
 * to set their password via Better Auth's `signUpEmail`, which creates the User +
 * Account + session. Role/initials are applied after sign-up (Better Auth owns
 * the password hash; our additionalFields are `input:false`).
 *
 * Email/initials uniqueness is DB-enforced (User.email / User.initials @unique).
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
  await txWithAudit(actor, async (tx, audit) => {
    // Supersede any still-pending invite(s) for this email first, so
    // re-inviting someone can't leave multiple valid tokens/roles coexisting —
    // only the newest invite should ever be resolvable.
    await tx.verification.deleteMany({ where: { identifier: input.email } });

    // Token keyed by the invitee's email so /accept-invite can look it up. The
    // role/initials/name are stashed as JSON in `value` (alongside the token)
    // since Verification is the only Better Auth table for opaque tokens.
    const payload = JSON.stringify({
      token,
      email: input.email,
      name: input.name,
      initials: input.initials.toUpperCase(),
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
  // lookup) would need a dedicated indexed token column — out of scope here.
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
 * Consume an invite: create the user via Better Auth with the chosen password,
 * then apply role/initials (input:false fields), then delete the invite row.
 * Throws on duplicate email (DB @unique) — surfaced by the route as 409/422.
 */
export async function acceptInvite(
  invite: InviteRecord,
  password: string,
): Promise<{ id: string; email: string }> {
  // Better Auth's signUpEmail creates the User + Account + Session outside our
  // control — it can't run inside our tx, so acceptance is NOT fully atomic.
  // Known limitation (inherent to Better Auth): if signUpEmail succeeds but the
  // txWithAudit below fails/rolls back, the User row persists with the DEFAULT
  // role (MEMBER, never the admin-chosen role — no privilege escalation) and a
  // usable password, while the invite token remains valid and no audit row is
  // written. That leaves an under-privileged orphan + a still-consumable invite,
  // never an over-privileged user. What IS atomic is everything downstream of
  // sign-up: the admin-chosen role/initials, consuming the invite token, and the
  // audit row all commit or roll back together in one txWithAudit.
  const { response } = await auth.api.signUpEmail({
    body: { email: invite.email, password, name: invite.name },
    returnHeaders: true,
  });

  // No session actor exists yet at invite-acceptance time (this runs from the
  // public /accept-invite route, pre-login). Use the newly created user itself
  // as the audit actor — it's the only identity available and it IS the entity
  // the row is about ("this user accepted their invite").
  const selfActor: AuditActor = {
    id: response.user.id,
    name: invite.name,
    email: invite.email,
    initials: invite.initials,
  };

  await txWithAudit(selfActor, async (tx, audit) => {
    // Apply the role/initials the admin chose (Better Auth can't set input:false
    // fields at sign-up, by design — no privilege escalation).
    await tx.user.update({
      where: { id: response.user.id },
      data: {
        role: invite.role,
        initials: invite.initials,
        emailVerified: true,
      },
    });

    // Single-use: delete any invite rows for this email/token.
    await tx.verification.deleteMany({
      where: { OR: [{ identifier: invite.email }, { value: { contains: invite.token } }] },
    });

    await audit({
      action: "InviteAccepted",
      entityType: "user",
      entityId: response.user.id,
      data: { role: invite.role, initials: invite.initials },
    });
  });

  return { id: response.user.id, email: response.user.email };
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
}
