import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { auth } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import {
  acceptInvite,
  createInvite,
  resolveInvite,
  updateUser,
} from "~/domains/auth/users.queries.server";
import {
  completePasswordReset,
  createPasswordReset,
  createPasswordResetForEmail,
  resolvePasswordReset,
} from "~/domains/auth/password-reset.server";

// Pass-through spy, so a test can tell whether the password KDF ran.
vi.mock("better-auth/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("better-auth/crypto")>();
  return { ...actual, hashPassword: vi.fn(actual.hashPassword) };
});

/**
 * One-time password reset links: issued by an admin (or the operator command),
 * consumed once to set a new password, and signing the account out everywhere.
 */
const AUTH_ORIGIN = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const RUN = `pwreset_${Date.now().toString(36)}`;
const ADMIN = { id: "test-admin", name: "Reset Admin", email: "admin@test.local", initials: "RA" };
const OLD_PASSWORD = "old-password-123";

const userIds: string[] = [];

async function inviteUser(
  suffix: string,
  initials: string,
): Promise<{ id: string; email: string }> {
  const email = `${RUN}_${suffix}@test.local`;
  const token = await createInvite(
    { email, name: `Reset ${suffix}`, initials, role: "MEMBER" },
    { name: "Test" },
  );
  const user = await acceptInvite(await resolveInvite(token), OLD_PASSWORD);
  userIds.push(user.id);
  return user;
}

async function signIn(email: string, password: string): Promise<Response> {
  return auth.handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      body: JSON.stringify({ email, password }),
    }),
  );
}

let member: { id: string; email: string };

beforeAll(async () => {
  member = await inviteUser("member", "PRM");
});

afterAll(async () => {
  await db.verification.deleteMany({ where: { value: { in: userIds } } });
  await db.session.deleteMany({ where: { userId: { in: userIds } } });
  await db.account.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});

describe("password reset links", () => {
  it("sets the new password once, signs out every session and audits both steps", async () => {
    expect((await signIn(member.email, OLD_PASSWORD)).ok).toBe(true);
    expect(await db.session.count({ where: { userId: member.id } })).toBeGreaterThan(0);

    const token = await createPasswordReset(member.id, ADMIN);
    // Only a hash of the token is stored.
    expect(await db.verification.count({ where: { identifier: { contains: token } } })).toBe(0);
    expect(await resolvePasswordReset(token)).toMatchObject({ email: member.email });

    await completePasswordReset(token, "brand-new-password-1");

    expect((await signIn(member.email, OLD_PASSWORD)).ok).toBe(false);
    expect(await db.session.count({ where: { userId: member.id } })).toBe(0);
    expect((await signIn(member.email, "brand-new-password-1")).ok).toBe(true);
    await expect(resolvePasswordReset(token)).rejects.toBeInstanceOf(NotFoundError);
    await expect(completePasswordReset(token, "another-password-2")).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const issued = await db.activityLog.findFirst({
      where: { action: "PasswordResetIssued", entityId: member.id },
    });
    expect(issued?.actorId).toBe(ADMIN.id);
    const reset = await db.activityLog.findFirst({
      where: { action: "PasswordReset", entityId: member.id },
    });
    expect(reset?.actorId).toBe(member.id);
  });

  it("invalidates the previous link when a new one is issued", async () => {
    const first = await createPasswordReset(member.id, ADMIN);
    const second = await createPasswordReset(member.id, ADMIN);
    await expect(resolvePasswordReset(first)).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolvePasswordReset(second)).resolves.toMatchObject({ email: member.email });
  });

  it("refuses an unknown link before hashing the submitted password", async () => {
    vi.mocked(hashPassword).mockClear();
    await expect(completePasswordReset("f".repeat(64), "any-password-123")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("refuses an expired link", async () => {
    const token = await createPasswordReset(member.id, ADMIN);
    await db.verification.updateMany({
      where: { value: member.id, identifier: { startsWith: "password-reset:" } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(completePasswordReset(token, "late-password-3")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("refuses a link for a deactivated account", async () => {
    const inactive = await inviteUser("inactive", "PRI");
    await db.user.update({ where: { id: inactive.id }, data: { isActive: false } });
    await expect(createPasswordReset(inactive.id, ADMIN)).rejects.toBeInstanceOf(ValidationError);
  });

  it("deletes the links of an account when it is deactivated", async () => {
    const leaving = await inviteUser("leaving", "PRL");
    const token = await createPasswordReset(leaving.id, ADMIN);
    await updateUser(
      leaving.id,
      { role: "MEMBER", initials: "PRL", isActive: false, weeklyCapacityHours: null },
      ADMIN,
    );
    await db.user.update({ where: { id: leaving.id }, data: { isActive: true } });
    // Reactivating must not bring back a link issued before the deactivation.
    await expect(resolvePasswordReset(token)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lets only one of two simultaneous submits of a link through", async () => {
    const token = await createPasswordReset(member.id, ADMIN);
    const results = await Promise.allSettled([
      completePasswordReset(token, "racing-password-a"),
      completePasswordReset(token, "racing-password-b"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(NotFoundError);
  });

  it("gives an account without a password credential one", async () => {
    const user = await db.user.create({
      data: { email: `${RUN}_nocred@test.local`, name: "No Credential", initials: "PRN" },
    });
    userIds.push(user.id);
    const token = await createPasswordReset(user.id, ADMIN);
    await completePasswordReset(token, "first-password-4");
    expect((await signIn(user.email, "first-password-4")).ok).toBe(true);
  });

  it("finds the account by email, in any letter case, for the operator command", async () => {
    const { token } = await createPasswordResetForEmail(member.email.toUpperCase(), {
      name: "Operator",
    });
    await expect(resolvePasswordReset(token)).resolves.toMatchObject({ email: member.email });
    await expect(
      createPasswordResetForEmail(`${RUN}_nobody@test.local`, { name: "Operator" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("pnpm admin:reset-password", () => {
  const run = promisify(execFile);
  const script = (email: string) =>
    run(process.execPath, ["--import", "tsx", "scripts/admin-reset-password.ts", email], {
      env: {
        PATH: process.env.PATH ?? "",
        DATABASE_URL: process.env.DATABASE_URL ?? "",
        BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
        BETTER_AUTH_URL: "https://av.example.test",
        DEFAULT_LOCALE: "en",
      },
    });

  it("prints a working one-time link for an existing account", async () => {
    const { stdout } = await script(member.email);
    const match = /https:\/\/av\.example\.test\/reset-password\/([0-9a-f]+)/.exec(stdout);
    expect(match).not.toBeNull();
    await expect(resolvePasswordReset(match![1]!)).resolves.toMatchObject({
      email: member.email,
    });
  });

  it("fails with a message and a non-zero exit for an unknown email", async () => {
    await expect(script(`${RUN}_unknown@test.local`)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/no active account/i),
    });
  });
});
