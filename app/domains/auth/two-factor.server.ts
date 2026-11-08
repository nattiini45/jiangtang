import { isAPIError } from "better-auth/api";
import { auth, MAX_PASSWORD_LENGTH, type AuthUser } from "~/lib/auth.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { db } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { qrSvg } from "~/lib/qr.server";
import { tr } from "~/i18n/request-locale.server";
import { msgKey } from "~/i18n";
import { z } from "~/lib/validation.server";

/**
 * Optional TOTP two-factor authentication. Better Auth's twoFactor plugin owns
 * the secret, the backup codes and the sign-in challenge; these functions call
 * its endpoints on the server, forward the cookies it sets and write the audit
 * row once a change has succeeded, as `changeOwnPassword` does. The admin reset
 * is ours alone, so it runs in one audited transaction.
 */

export const twoFactorPasswordSchema = z.object({
  password: z
    .string()
    .min(1, msgKey("account.password.err.currentRequired"))
    .max(MAX_PASSWORD_LENGTH, msgKey("account.password.err.currentWrong")),
});

export const twoFactorCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, msgKey("account.twoFactor.err.codeRequired"))
    .max(32, msgKey("account.twoFactor.err.codeInvalid")),
});

export interface TwoFactorEnrolment {
  qrSvg: string;
  secret: string;
  backupCodes: string[];
}

function actorOf(user: AuthUser): AuditActor {
  return { id: user.id, name: user.name, email: user.email, initials: user.initials };
}

function errorCode(e: unknown): string | undefined {
  return isAPIError(e) ? (e.body?.code as string | undefined) : undefined;
}

function rethrowWrongPassword(e: unknown): never {
  if (errorCode(e) === "INVALID_PASSWORD") {
    throw new ValidationError({ password: [tr("account.password.err.currentWrong")] });
  }
  throw e;
}

/**
 * Start enrolment: Better Auth stores a new, unverified secret with fresh backup
 * codes. Nothing changes at sign-in until the first code is confirmed, and
 * starting again replaces an unconfirmed secret.
 */
export async function startTwoFactorEnrolment(
  request: Request,
  password: string,
): Promise<TwoFactorEnrolment> {
  let result: Awaited<ReturnType<typeof auth.api.enableTwoFactor>>;
  try {
    result = await auth.api.enableTwoFactor({
      body: { password, method: "totp" },
      headers: request.headers,
    });
  } catch (e) {
    if (errorCode(e) === "TOTP_ALREADY_ENABLED") {
      throw new ValidationError({}, [tr("account.twoFactor.err.alreadyEnabled")]);
    }
    rethrowWrongPassword(e);
  }
  if (result.method !== "totp") throw new Error("Better Auth did not start a TOTP enrolment");
  return {
    qrSvg: await qrSvg(result.totpURI, 192),
    secret: new URL(result.totpURI).searchParams.get("secret") ?? "",
    backupCodes: result.backupCodes,
  };
}

/**
 * Confirm enrolment with a code from the authenticator. Better Auth then turns
 * two-factor on and rotates this browser's session; the new session cookie is
 * in the returned headers.
 */
export async function confirmTwoFactorEnrolment(
  user: AuthUser,
  request: Request,
  code: string,
): Promise<Headers> {
  let headers: Headers;
  try {
    ({ headers } = await auth.api.verifyTOTP({
      body: { code },
      headers: request.headers,
      returnHeaders: true,
    }));
  } catch (e) {
    if (errorCode(e) === "INVALID_CODE") {
      throw new ValidationError({ code: [tr("account.twoFactor.err.codeInvalid")] });
    }
    if (errorCode(e) === "TOTP_NOT_ENABLED") {
      throw new ValidationError({}, [tr("account.twoFactor.err.enrolmentExpired")]);
    }
    throw e;
  }
  await txWithAudit(actorOf(user), async (_tx, audit) => {
    await audit({ action: "TwoFactorEnabled", entityType: "user", entityId: user.id });
  });
  return headers;
}

/** Turn two-factor off for the signed-in user; requires the password. */
export async function disableOwnTwoFactor(
  user: AuthUser,
  request: Request,
  password: string,
): Promise<Headers> {
  let headers: Headers;
  try {
    ({ headers } = await auth.api.disableTwoFactor({
      body: { password },
      headers: request.headers,
      returnHeaders: true,
    }));
  } catch (e) {
    rethrowWrongPassword(e);
  }
  await txWithAudit(actorOf(user), async (_tx, audit) => {
    await audit({ action: "TwoFactorDisabled", entityType: "user", entityId: user.id });
  });
  return headers;
}

/** Replace the backup codes; the old ones stop working. Requires the password. */
export async function regenerateBackupCodes(
  user: AuthUser,
  request: Request,
  password: string,
): Promise<string[]> {
  let backupCodes: string[];
  try {
    ({ backupCodes } = await auth.api.generateBackupCodes({
      body: { password },
      headers: request.headers,
    }));
  } catch (e) {
    rethrowWrongPassword(e);
  }
  await txWithAudit(actorOf(user), async (_tx, audit) => {
    await audit({
      action: "TwoFactorBackupCodesRegenerated",
      entityType: "user",
      entityId: user.id,
    });
  });
  return backupCodes;
}

export type SecondFactorResult =
  { ok: true; headers: Headers } | { ok: false; reason: "invalidCode" | "expired" | "locked" };

/**
 * Finish a sign-in that Better Auth paused for the second factor. The challenge
 * lives in a signed cookie on the request; a correct TOTP or an unused backup
 * code exchanges it for a session cookie. Better Auth limits the attempts per
 * challenge and locks the second factor after repeated failures across
 * challenges.
 */
export async function completeTwoFactorSignIn(
  request: Request,
  input: { code: string; method: "totp" | "backup" },
): Promise<SecondFactorResult> {
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  try {
    const { headers: responseHeaders } =
      input.method === "backup"
        ? await auth.api.verifyBackupCode({
            body: { code: input.code },
            headers,
            returnHeaders: true,
          })
        : await auth.api.verifyTOTP({ body: { code: input.code }, headers, returnHeaders: true });
    return { ok: true, headers: responseHeaders };
  } catch (e) {
    switch (errorCode(e)) {
      case "INVALID_CODE":
      case "INVALID_BACKUP_CODE":
        return { ok: false, reason: "invalidCode" };
      case "ACCOUNT_TEMPORARILY_LOCKED":
        return { ok: false, reason: "locked" };
      case "INVALID_TWO_FACTOR_COOKIE":
      case "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE":
      case "TOTP_NOT_ENABLED":
      case "BACKUP_CODES_NOT_ENABLED":
        return { ok: false, reason: "expired" };
      default:
        throw e;
    }
  }
}

/**
 * Admin reset for a person who lost their authenticator and backup codes: the
 * secret and the backup codes are deleted and two-factor is off, so the
 * password alone signs in again until they enrol anew.
 */
export async function resetTwoFactor(userId: string, actor: AuditActor): Promise<void> {
  await txWithAudit(actor, async (tx, audit) => {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, twoFactorEnabled: true },
    });
    if (!user) throw new NotFoundError(tr("places.err.user.notFound"));
    const removed = await tx.twoFactor.deleteMany({ where: { userId } });
    if (!user.twoFactorEnabled && removed.count === 0) {
      throw new ValidationError({}, [tr("admin.user.twoFactor.err.notEnabled")]);
    }
    await tx.user.update({ where: { id: userId }, data: { twoFactorEnabled: false } });
    await audit({ action: "TwoFactorReset", entityType: "user", entityId: userId });
  });
}

/**
 * The operator command's entry (`pnpm admin:reset-2fa <email>`), for when the
 * only admin lost their second factor: find the active account by email (any
 * letter case) and reset it like the admin page does.
 */
export async function resetTwoFactorForEmail(email: string, actor: AuditActor): Promise<string> {
  const user = await db.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" }, isActive: true },
    select: { id: true, email: true },
  });
  if (!user) throw new NotFoundError(tr("places.err.reset.noAccount"));
  await resetTwoFactor(user.id, actor);
  return user.email;
}
