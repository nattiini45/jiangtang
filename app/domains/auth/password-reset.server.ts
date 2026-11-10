import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { db, type Tx } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { revokeUserPersonalAccessTokens } from "~/domains/api-tokens/api-tokens.lifecycle.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { ENTITY_TYPE } from "~/domains/tickets/tickets.history.server";

/**
 * One-time password reset links. An admin issues one from the user's page; when
 * no admin can sign in, the operator prints one with `pnpm admin:reset-password
 * <email>` (in the container: `node --import tsx scripts/admin-reset-password.ts
 * <email>`). The person opens `/reset-password/<token>` and picks a new password;
 * that sets the Better Auth credential, consumes the link and signs the account
 * out everywhere in one audited transaction.
 *
 * The link lives in `Verification` like an invitation, but only a SHA-256 of the
 * token is stored, so a database copy holds no usable link. The `password-reset:`
 * prefix keeps it apart from invitations and from Better Auth's own
 * `reset-password:` rows, which its `/reset-password` endpoint would accept.
 */

const RESET_TTL_MS = 1000 * 60 * 60 * 24; // 1 day
export const RESET_IDENTIFIER_PREFIX = "password-reset:";

function identifierFor(token: string): string {
  return RESET_IDENTIFIER_PREFIX + createHash("sha256").update(token).digest("hex");
}

/** Path of the page that consumes a reset token. */
export function passwordResetPath(token: string): string {
  return `/reset-password/${token}`;
}

/** Issue a reset link for an active user, replacing any earlier one. Returns the token. */
export async function createPasswordReset(userId: string, actor: AuditActor): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const revokedTokenCount = await txWithAudit(actor, async (tx, audit) => {
    // Lock the user row so two simultaneous issues run one after the other and
    // the second replaces the first, instead of both surviving.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError(tr("places.err.user.notFound"));
    // A deactivated account could set a password but never sign in with it.
    if (!user.isActive) throw new ValidationError({}, [tr("places.err.reset.inactive")]);

    await deleteResetLinks(tx, userId);
    await tx.verification.create({
      data: {
        identifier: identifierFor(token),
        value: userId,
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });
    const revokedCount = await revokeUserPersonalAccessTokens(
      tx,
      audit,
      userId,
      "PASSWORD_RESET_ISSUED",
    );
    await audit({ action: "PasswordResetIssued", entityType: "user", entityId: userId });
    return revokedCount;
  });
  if (revokedTokenCount > 0) {
    await emitChange({ entityType: ENTITY_TYPE.user, id: userId, op: "updated" });
  }
  return token;
}

/** The operator command's entry: find the active account by email (any letter case). */
export async function createPasswordResetForEmail(
  email: string,
  actor: AuditActor,
): Promise<{ token: string; email: string }> {
  const user = await db.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" }, isActive: true },
    select: { id: true, email: true },
  });
  if (!user) throw new NotFoundError(tr("places.err.reset.noAccount"));
  return { token: await createPasswordReset(user.id, actor), email: user.email };
}

export interface PasswordResetRecord {
  userId: string;
  email: string;
  name: string;
}

async function findResetLink(tx: Tx, token: string): Promise<PasswordResetRecord> {
  const row = await tx.verification.findFirst({ where: { identifier: identifierFor(token) } });
  if (!row || row.expiresAt <= new Date()) {
    throw new NotFoundError(tr("places.err.reset.notFound"));
  }
  const user = await tx.user.findUnique({ where: { id: row.value } });
  if (!user || !user.isActive) throw new NotFoundError(tr("places.err.reset.notFound"));
  return { userId: user.id, email: user.email, name: user.name };
}

/** Look up a reset token; NotFoundError when it is unknown, used, expired or the account is inactive. */
export async function resolvePasswordReset(token: string): Promise<PasswordResetRecord> {
  return findResetLink(db, token);
}

/**
 * Set the new password from a reset link: update (or create) the credential,
 * consume the link and delete every session of the account, all or nothing.
 */
export async function completePasswordReset(token: string, password: string): Promise<void> {
  // The page is public: refuse an unknown or expired token before spending the
  // password KDF on it. The transaction below checks again, for races.
  const pending = await findResetLink(db, token);
  const passwordHash = await hashPassword(password);
  const actor: AuditActor = {};
  const { userId, revokedTokenCount } = await txWithAudit(actor, async (tx, audit) => {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${pending.userId} FOR UPDATE`;
    const link = await findResetLink(tx, token);
    // The account is the actor; `audit` reads the actor when it is called.
    Object.assign(actor, { id: link.userId, name: link.name, email: link.email });

    // The consume is the guard against a double submit: only one transaction
    // can delete the row.
    const consumed = await tx.verification.deleteMany({
      where: { identifier: identifierFor(token) },
    });
    if (consumed.count !== 1) throw new NotFoundError(tr("places.err.reset.notFound"));

    const updated = await tx.account.updateMany({
      where: { userId: link.userId, providerId: "credential" },
      data: { password: passwordHash },
    });
    if (updated.count === 0) {
      await tx.account.create({
        data: {
          userId: link.userId,
          accountId: link.userId,
          providerId: "credential",
          password: passwordHash,
        },
      });
    }
    await tx.session.deleteMany({ where: { userId: link.userId } });
    await deleteResetLinks(tx, link.userId);
    const revokedTokenCount = await revokeUserPersonalAccessTokens(
      tx,
      audit,
      link.userId,
      "PASSWORD_RESET_COMPLETED",
    );
    await audit({
      action: "PasswordReset",
      entityType: "user",
      entityId: link.userId,
      data: { sessionsRevoked: true },
    });
    return { userId: link.userId, revokedTokenCount };
  });
  if (revokedTokenCount > 0) {
    await emitChange({ entityType: ENTITY_TYPE.user, id: userId, op: "updated" });
  }
}

/** Delete every reset link of a user (also used by the erasure). */
export async function deleteResetLinks(tx: Tx, userId: string): Promise<void> {
  await tx.verification.deleteMany({
    where: { identifier: { startsWith: RESET_IDENTIFIER_PREFIX }, value: userId },
  });
}
