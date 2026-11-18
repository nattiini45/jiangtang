import { createHmac } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { txWithAudit } from "~/lib/audit.server";
import { readConfig } from "~/lib/config.server";
import { db } from "~/lib/db.server";
import { logger } from "~/lib/observability/logger.server";
import { clientIpFromHeaders, createLoginThrottle } from "~/lib/login-throttle.server";
import { queueMail, readMailSettings } from "~/domains/mail/mail.server";
import { t, type MessageKey, type MessageParams } from "~/i18n";
import { resolveLocale, workspaceLocale } from "~/i18n/locale.server";
import { currentLocale } from "~/i18n/request-locale.server";

export const EMAIL_RESET_PREFIX = "email-password-reset:";
export const BETTER_AUTH_RESET_PREFIX = "reset-password:";
export const RESET_LIFETIME_SECONDS = 3600;
export const VERIFICATION_LIFETIME_SECONDS = 3600;
const RESET_MAIL_COOLDOWN_MS = 60_000;

export function hashEmailResetIdentifier(identifier: string) {
  const key = readConfig("BETTER_AUTH_SECRET");
  if (!key) throw new Error("BETTER_AUTH_SECRET must be configured for email recovery.");
  return EMAIL_RESET_PREFIX + createHmac("sha256", key).update(identifier).digest("hex");
}

function publicUrl(path: string) {
  const base = readConfig("BETTER_AUTH_URL");
  return base ? new URL(path, base).href : null;
}

export async function accountMailReady() {
  if (!readConfig("BETTER_AUTH_URL") || !readConfig("BETTER_AUTH_SECRET")) return false;
  return (await readMailSettings().catch(() => null))?.ready ?? false;
}

export function inviteMailProof(token: string, email: string) {
  const key = readConfig("BETTER_AUTH_SECRET");
  if (!key) return null;
  return createHmac("sha256", key)
    .update("jiangtang-email-invitation-v1\0")
    .update(token)
    .update("\0")
    .update(email)
    .digest();
}

async function enqueueAccountMail(
  kind: string,
  recipient: string,
  template: { subject: MessageKey; text: MessageKey },
  params: MessageParams,
  locale = currentLocale(),
  expiresAt?: Date,
) {
  try {
    const row = await txWithAudit(null, (tx) =>
      queueMail(tx, {
        kind,
        recipient,
        subject: t(locale, template.subject, params),
        text: t(locale, template.text, params),
        expiresAt,
      }),
    );
    return row.status === "queued";
  } catch {
    logger.error({ kind }, "[mail] Account message could not be queued");
    return false;
  }
}

export async function sendInviteEmail(input: {
  token: string;
  email: string;
  expiresAt: Date;
  request: Request;
}) {
  if (!(await accountMailReady())) return false;
  const proof = inviteMailProof(input.token, input.email);
  if (!proof) return false;
  const link = publicUrl(`/accept-invite/${input.token}.${proof.toString("hex")}`);
  if (!link) return false;
  return enqueueAccountMail(
    "invitation",
    input.email,
    { subject: "auth.mail.inviteSubject", text: "auth.mail.inviteText" },
    { link },
    resolveLocale(input.request),
    input.expiresAt,
  );
}

const resetThrottle = createLoginThrottle({ maxEmailFailures: 3, maxIpFailures: 20 });
const verificationThrottle = createLoginThrottle({ maxEmailFailures: 3, maxIpFailures: 20 });

export async function requestEmailPasswordReset(email: string, request: Request) {
  const start = Date.now();
  const ip = clientIpFromHeaders(request.headers);
  if (!resetThrottle.begin({ email, ip }).allowed) return;
  try {
    const account = await db.user.findUnique({
      where: { email },
      select: { isActive: true, emailVerified: true },
    });
    if (account?.isActive && account.emailVerified) {
      const { auth } = await import("~/lib/auth.server");
      await auth.api.requestPasswordReset({ body: { email }, request, asResponse: false });
    }
  } catch {
    logger.error("[mail] Password reset request could not be processed");
  } finally {
    await setTimeout(Math.max(0, 400 - (Date.now() - start)));
  }
}

export async function sendPasswordResetMail(
  { user, token }: { user: { email: string }; token: string },
  request?: Request,
) {
  const link = publicUrl(`/reset-password/email-${token}`);
  if (!link) return;
  const recipient = user.email;
  const locale = request ? resolveLocale(request) : currentLocale();
  await txWithAudit(null, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`reset-mail:${recipient}`}, 0))`;
    const recent = await tx.mailDelivery.findFirst({
      where: {
        kind: "password-reset",
        recipient,
        createdAt: { gte: new Date(Date.now() - RESET_MAIL_COOLDOWN_MS) },
        status: { in: ["queued", "retrying", "sent"] },
      },
      select: { id: true },
    });
    if (!recent) {
      const row = await queueMail(tx, {
        kind: "password-reset",
        recipient,
        subject: t(locale, "auth.mail.resetSubject"),
        text: t(locale, "auth.mail.resetText", { link }),
        expiresAt: new Date(Date.now() + RESET_LIFETIME_SECONDS * 1000),
      });
      if (row.status === "queued") return;
    }
    await tx.verification.deleteMany({
      where: { identifier: hashEmailResetIdentifier(BETTER_AUTH_RESET_PREFIX + token) },
    });
  });
}

export async function requestEmailVerification(email: string, request: Request) {
  if (!(await accountMailReady())) return false;
  if (!verificationThrottle.begin({ email, ip: clientIpFromHeaders(request.headers) }).allowed) {
    return false;
  }
  try {
    const { auth } = await import("~/lib/auth.server");
    await auth.api.sendVerificationEmail({
      body: { email, callbackURL: "/account" },
      headers: request.headers,
    });
    return true;
  } catch {
    logger.error("[mail] Verification request could not be processed");
    return false;
  }
}

export async function sendVerificationMail(
  { user, url }: { user: { email: string }; url: string },
  request?: Request,
) {
  const queued = await enqueueAccountMail(
    "email-verification",
    user.email,
    { subject: "auth.mail.verifySubject", text: "auth.mail.verifyText" },
    { link: url },
    request ? resolveLocale(request) : currentLocale(),
    new Date(Date.now() + VERIFICATION_LIFETIME_SECONDS * 1000),
  );
  if (!queued) throw new Error("Verification email could not be queued.");
}

export async function sendAdminNotice(kind: "new-admin" | "two-factor-reset", userEmail: string) {
  try {
    if (!(await accountMailReady())) return;
    const template =
      kind === "new-admin"
        ? ({ subject: "auth.mail.adminSubject", text: "auth.mail.adminText" } as const)
        : ({ subject: "auth.mail.twoFactorSubject", text: "auth.mail.twoFactorText" } as const);
    const admins = await db.user.findMany({
      where: {
        role: "ADMIN",
        isActive: true,
        emailVerified: true,
        ...(kind === "new-admin" ? { email: { not: userEmail } } : {}),
      },
      select: { email: true },
    });
    for (const admin of admins) {
      await enqueueAccountMail(
        kind,
        admin.email,
        template,
        { email: userEmail },
        workspaceLocale(),
      );
    }
  } catch {
    logger.error({ kind }, "[mail] Security notification recipients could not be resolved");
  }
}
