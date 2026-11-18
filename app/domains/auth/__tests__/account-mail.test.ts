import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { auth } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { getJobQueue, startJobQueue, stopJobQueue } from "~/lib/jobs.server";
import { openSecret } from "~/lib/settings.server";
import {
  accountMailReady,
  requestEmailPasswordReset,
  requestEmailVerification,
  sendInviteEmail,
} from "~/domains/auth/account-mail.server";
import { completePasswordReset, resolvePasswordReset } from "~/domains/auth/password-reset.server";
import {
  acceptInvite,
  changeInvitation,
  createInvite,
  resolveInvite,
  updateUser,
} from "~/domains/auth/users.queries.server";
import { resetTwoFactor } from "~/domains/auth/two-factor.server";
import {
  MAIL_QUEUE,
  readMailSettings,
  registerMailWorker,
  saveSmtp,
} from "~/domains/mail/mail.server";

vi.hoisted(() => {
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3100");
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-account-mail-secret-not-for-production");
});

const prefix = `account-mail-${crypto.randomUUID()}`;
const email = (id: string) => `${prefix}-${id}@example.test`;
const actor = { name: "Synthetic administrator" };
const password = "synthetic-old-password";
const request = new Request("http://localhost:3100/forgot-password", {
  method: "POST",
  headers: { "Accept-Language": "en", Origin: "http://localhost:3100" },
});

beforeAll(async () => {
  expect(await accountMailReady()).toBe(false);
  await startJobQueue();
  await registerMailWorker();
  await getJobQueue()!.offWork(MAIL_QUEUE, { wait: true });
  await saveSmtp(actor, {
    host: "mail.example.test",
    port: 587,
    tls: "starttls",
    from: "sender@example.test",
    username: "",
    password: "",
    enabled: true,
    clearPassword: false,
  });
  expect(await accountMailReady()).toBe(false);
  const { config } = await readMailSettings();
  await db.mailDelivery.create({
    data: {
      kind: "test",
      recipient: email("test"),
      revision: config!.revision,
      status: "sent",
      expiresAt: new Date(Date.now() + 86400_000),
      finishedAt: new Date(),
    },
  });
  expect(await accountMailReady()).toBe(true);
});

afterAll(async () => {
  try {
    const users = await db.user.findMany({
      where: { email: { startsWith: prefix } },
      select: { id: true },
    });
    await db.verification.deleteMany({ where: { value: { in: users.map((user) => user.id) } } });
    await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
    await db.invitation.deleteMany({ where: { email: { startsWith: prefix } } });
    await db.mailDelivery.deleteMany({ where: { recipient: { startsWith: prefix } } });
    await db.setting.deleteMany({ where: { key: "smtp" } });
    await getJobQueue()?.deleteAllJobs(MAIL_QUEUE);
  } finally {
    await stopJobQueue();
    vi.unstubAllEnvs();
  }
});

async function newestLink(kind: string, recipient: string) {
  const row = await db.mailDelivery.findFirstOrThrow({
    where: { kind, recipient },
    orderBy: { createdAt: "desc" },
  });
  expect(row.status).toBe("queued");
  const message = JSON.parse(openSecret(`mail:${row.id}`, row.payload!)) as { text: string };
  return new URL(message.text.match(/^http:\/\/\S+/m)![0]);
}

it("verifies only the mailed invitation, then completes the Better Auth reset token through audited recovery", async () => {
  const address = email("invitee");
  const token = await createInvite(
    { email: address, initials: "XMA", name: "Synthetic invitee", role: "MEMBER" },
    actor,
  );
  const invite = await resolveInvite(token);
  expect(invite.mailed).toBe(false);
  expect(await sendInviteEmail({ ...invite, request })).toBe(true);
  const mailedToken = (await newestLink("invitation", address)).pathname.split("/").pop()!;
  await expect(resolveInvite(`${token}.${"a".repeat(64)}`)).rejects.toThrow();
  const accepted = await acceptInvite(await resolveInvite(mailedToken), password);
  expect(
    await db.user.findUnique({ where: { id: accepted.id }, select: { emailVerified: true } }),
  ).toEqual({ emailVerified: true });
  await expect(resolveInvite(token)).rejects.toThrow();
  const oldSession = await auth.api.signInEmail({ body: { email: address, password } });
  expect(oldSession.user.id).toBe(accepted.id);

  await Promise.all([
    requestEmailPasswordReset(address, request),
    requestEmailPasswordReset(
      address,
      new Request(request, { headers: { "X-Forwarded-For": "192.0.2.1" } }),
    ),
  ]);
  expect(
    await db.mailDelivery.count({ where: { recipient: address, kind: "password-reset" } }),
  ).toBe(1);
  expect(await db.verification.count({ where: { value: accepted.id } })).toBe(1);
  const resetToken = (await newestLink("password-reset", address)).pathname.split("/").pop()!;
  const raw = resetToken.slice("email-".length);
  const saved = await db.verification.findFirstOrThrow({ where: { value: accepted.id } });
  expect(saved.identifier).toBe(
    "email-password-reset:" + createHash("sha256").update(`reset-password:${raw}`).digest("hex"),
  );
  await db.user.update({ where: { id: accepted.id }, data: { emailVerified: false } });
  await expect(resolvePasswordReset(resetToken)).rejects.toThrow();
  await db.user.update({ where: { id: accepted.id }, data: { emailVerified: true } });
  await expect(resolvePasswordReset(resetToken)).resolves.toMatchObject({ email: address });
  await completePasswordReset(resetToken, "synthetic-new-password");
  await expect(resolvePasswordReset(resetToken)).rejects.toThrow();
  expect(await db.session.count({ where: { userId: accepted.id } })).toBe(0);
  await expect(
    auth.api.signInEmail({ body: { email: address, password: "synthetic-new-password" } }),
  ).resolves.toMatchObject({ user: { id: accepted.id } });
});

it("does not mail a reset for an unverified account, but lets it verify through Better Auth", async () => {
  const address = email("manual");
  const token = await createInvite(
    { email: address, initials: "XMB", name: "Synthetic manual invitee", role: "MEMBER" },
    actor,
  );
  const invite = await resolveInvite(token);
  const user = await acceptInvite(invite, password);
  await requestEmailPasswordReset(address, request);
  expect(
    await db.mailDelivery.count({ where: { recipient: address, kind: "password-reset" } }),
  ).toBe(0);
  const response = await auth.api.signInEmail({
    body: { email: address, password },
    asResponse: true,
  });
  const verifyRequest = new Request("http://localhost:3100/account", {
    headers: {
      Cookie: response.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
      "Accept-Language": "en",
    },
  });
  expect(await requestEmailVerification(address, verifyRequest)).toBe(true);
  const link = await newestLink("email-verification", address);
  expect((await auth.handler(new Request(link))).status).toBe(302);
  expect(
    await db.user.findUnique({ where: { id: user.id }, select: { emailVerified: true } }),
  ).toEqual({ emailVerified: true });
});

it("invalidates both forms of an invitation on reissue", async () => {
  const address = email("rotate");
  const token = await createInvite(
    { email: address, initials: "XMC", name: "Synthetic invitee", role: "MEMBER" },
    actor,
  );
  const invite = await resolveInvite(token);
  await sendInviteEmail({ ...invite, request });
  const mailedToken = (await newestLink("invitation", address)).pathname.split("/").pop()!;
  await changeInvitation(invite.id, "reissue", actor);
  await expect(resolveInvite(token)).rejects.toThrow();
  await expect(resolveInvite(mailedToken)).rejects.toThrow();
});

it("sends security notices to existing verified active administrators", async () => {
  const admin = await db.user.create({
    data: { name: "Synthetic admin", email: email("admin"), role: "ADMIN", emailVerified: true },
  });
  const member = await db.user.create({
    data: {
      name: "Synthetic member",
      email: email("member"),
      initials: "XMD",
      twoFactorEnabled: true,
    },
  });
  await updateUser(
    member.id,
    { role: "ADMIN", isActive: true, initials: "XMD", weeklyCapacityHours: null },
    actor,
  );
  await resetTwoFactor(member.id, actor);
  const notices = await db.mailDelivery.findMany({
    where: { recipient: admin.email },
    select: { kind: true },
  });
  expect(notices).toEqual(
    expect.arrayContaining([{ kind: "new-admin" }, { kind: "two-factor-reset" }]),
  );
  expect(await db.mailDelivery.count({ where: { recipient: member.email } })).toBe(0);
});
