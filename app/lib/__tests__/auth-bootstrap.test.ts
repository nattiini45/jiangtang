import { hashPassword } from "better-auth/crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { bootstrapFirstAdmin, type FirstAdminBootstrapDeps } from "~/lib/auth-bootstrap.server";

/**
 * First-admin bootstrap. It acts only when no active ADMIN exists.
 *
 * The shared test database is seeded with admins, so the "no active admin" state is
 * injected through the deps argument. The "an active admin exists" state is created
 * as a real row and checked through the default database query.
 *
 * Every row this suite creates is namespaced by RUN and removed in afterAll (FK order:
 * Session/Account → User). ActivityLog rows are append-only, so the UserBootstrapped
 * audit rows this suite provokes are asserted and left in place, never deleted.
 */

const RUN = `t_authboot_${Date.now()}`;
const ADMIN_PASSWORD = "bootstrap-pw-123";
const NO_ACTIVE_ADMIN: FirstAdminBootstrapDeps = { activeAdminExists: async () => false };

const createdEmails: string[] = [];

function emailFor(label: string): string {
  const email = `${RUN}_${label}@jiangtang.local`;
  createdEmails.push(email);
  return email;
}

async function insertUser(
  email: string,
  fields: { role: "ADMIN" | "MEMBER"; isActive: boolean; initials?: string },
): Promise<{ id: string }> {
  return db.user.create({
    data: {
      email,
      name: "Bootstrap fixture",
      role: fields.role,
      isActive: fields.isActive,
      emailVerified: false,
      initials: fields.initials ?? null,
    },
    select: { id: true },
  });
}

async function insertCredential(userId: string, password: string): Promise<void> {
  await db.account.create({
    data: {
      accountId: userId,
      providerId: "credential",
      userId,
      password: await hashPassword(password),
    },
  });
}

async function deleteUserByEmail(email: string): Promise<void> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) return;
  await db.session.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
  await db.account.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
  await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const email of createdEmails) {
    await deleteUserByEmail(email);
  }
  await db.$disconnect();
});

describe("bootstrapFirstAdmin", () => {
  it("on a fresh database, creates the ADMIN with emailVerified, isActive and derived initials", async () => {
    const email = emailFor("fresh");
    vi.stubEnv("ADMIN_EMAIL", email);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
    // Pin the derivation branch: the dev .env sets ADMIN_INITIALS, and an
    // un-stubbed ambient value silently takes the explicit branch instead.
    vi.stubEnv("ADMIN_INITIALS", "");

    await bootstrapFirstAdmin(NO_ACTIVE_ADMIN);

    const user = await db.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user?.role).toBe("ADMIN");
    expect(user?.emailVerified).toBe(true);
    expect(user?.isActive).toBe(true);
    // derived from local part "t_authboot_<ts>_fresh" → alnum, uppercased, first 3 chars.
    expect(user?.initials).toBe("TAU");

    // The domain-field update carries an audit row like every mutation.
    const auditRows = await db.activityLog.findMany({
      where: { action: "UserBootstrapped", entityType: "user", entityId: user!.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorSnapshot).toMatchObject({ name: "system" });
  });

  it("prefers an explicit ADMIN_INITIALS over the derived value", async () => {
    const email = emailFor("explicit");
    vi.stubEnv("ADMIN_EMAIL", email);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
    vi.stubEnv("ADMIN_INITIALS", "zc");

    await bootstrapFirstAdmin(NO_ACTIVE_ADMIN);

    const user = await db.user.findUnique({ where: { email } });
    expect(user?.initials).toBe("ZC");
  });

  it("with no active admin, promotes an existing ADMIN_EMAIL account whose password matches (recovery)", async () => {
    const email = emailFor("recovery");
    const { id } = await insertUser(email, { role: "MEMBER", isActive: true });
    await insertCredential(id, ADMIN_PASSWORD);
    vi.stubEnv("ADMIN_EMAIL", email);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
    vi.stubEnv("ADMIN_INITIALS", "");

    await bootstrapFirstAdmin(NO_ACTIVE_ADMIN);

    const user = await db.user.findUniqueOrThrow({ where: { id } });
    expect(user.role).toBe("ADMIN");
    expect(user.isActive).toBe(true);
    expect(user.emailVerified).toBe(true);
    expect(await db.user.count({ where: { email } })).toBe(1);
  });

  it("with no active admin, leaves an existing account alone when ADMIN_PASSWORD does not match its password", async () => {
    const email = emailFor("recovery-mismatch");
    // The account still has the password it was created with; ADMIN_PASSWORD was rotated.
    const { id } = await insertUser(email, { role: "MEMBER", isActive: false });
    await insertCredential(id, "previous-pw-789");
    vi.stubEnv("ADMIN_EMAIL", email);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
    vi.stubEnv("ADMIN_INITIALS", "");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await bootstrapFirstAdmin(NO_ACTIVE_ADMIN);

    const user = await db.user.findUniqueOrThrow({ where: { id } });
    expect(user.role).toBe("MEMBER");
    expect(user.isActive).toBe(false);
    expect(user.emailVerified).toBe(false);
    const auditRows = await db.activityLog.findMany({
      where: { action: "UserBootstrapped", entityId: id },
    });
    expect(auditRows).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("does not match"));
  });

  it("with no active admin, does not promote an existing ADMIN_EMAIL account that has no password credential", async () => {
    const email = emailFor("recovery-no-credential");
    const { id } = await insertUser(email, { role: "MEMBER", isActive: false });
    vi.stubEnv("ADMIN_EMAIL", email);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
    vi.stubEnv("ADMIN_INITIALS", "");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await bootstrapFirstAdmin(NO_ACTIVE_ADMIN);

    const user = await db.user.findUniqueOrThrow({ where: { id } });
    expect(user.role).toBe("MEMBER");
    expect(user.isActive).toBe(false);
    const auditRows = await db.activityLog.findMany({
      where: { action: "UserBootstrapped", entityId: id },
    });
    expect(auditRows).toHaveLength(0);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("no password credential"));
  });

  it.each([
    { label: "demoted", role: "MEMBER", isActive: true },
    { label: "deactivated", role: "ADMIN", isActive: false },
  ] as const)(
    "with an active admin present, leaves a $label ADMIN_EMAIL account alone",
    async ({ label, role, isActive }) => {
      const email = emailFor(label);
      const { id } = await insertUser(email, { role, isActive });
      // The active admin is a real row, so the default database check sees it.
      await insertUser(emailFor(`${label}-active`), { role: "ADMIN", isActive: true });
      vi.stubEnv("ADMIN_EMAIL", email);
      vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
      vi.stubEnv("ADMIN_INITIALS", "");

      await bootstrapFirstAdmin();

      const user = await db.user.findUniqueOrThrow({ where: { id } });
      expect(user.role).toBe(role);
      expect(user.isActive).toBe(isActive);
      const auditRows = await db.activityLog.findMany({
        where: { action: "UserBootstrapped", entityId: id },
      });
      expect(auditRows).toHaveLength(0);
    },
  );

  it("with an active admin present, creates no account for an unknown ADMIN_EMAIL", async () => {
    const email = emailFor("unknown");
    await insertUser(emailFor("unknown-active"), { role: "ADMIN", isActive: true });
    vi.stubEnv("ADMIN_EMAIL", email);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);

    await bootstrapFirstAdmin();

    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });

  it("is idempotent: a second boot after provisioning creates no duplicate", async () => {
    const email = emailFor("idempotent");
    vi.stubEnv("ADMIN_EMAIL", email);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
    vi.stubEnv("ADMIN_INITIALS", "");

    await bootstrapFirstAdmin(NO_ACTIVE_ADMIN);
    await expect(bootstrapFirstAdmin()).resolves.toBeUndefined();

    expect(await db.user.findMany({ where: { email } })).toHaveLength(1);
  });

  it("promotes without initials when another account already holds them", async () => {
    // "QZX" is not derivable from any test email, so only this holder can clash.
    const holder = await insertUser(emailFor("clash-holder"), {
      role: "MEMBER",
      isActive: true,
      initials: "QZX",
    });
    const email = emailFor("clash");
    vi.stubEnv("ADMIN_EMAIL", email);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
    vi.stubEnv("ADMIN_INITIALS", "qzx");

    await bootstrapFirstAdmin(NO_ACTIVE_ADMIN);

    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect(user.role).toBe("ADMIN");
    expect(user.isActive).toBe(true);
    expect(user.emailVerified).toBe(true);
    expect(user.initials).toBeNull();
    // The clash branch still writes its audit row.
    const auditRows = await db.activityLog.findMany({
      where: { action: "UserBootstrapped", entityId: user.id },
    });
    expect(auditRows).toHaveLength(1);
    // The holder keeps the initials it already had.
    const holderAfter = await db.user.findUniqueOrThrow({ where: { id: holder.id } });
    expect(holderAfter.initials).toBe("QZX");
  });

  it("creates no user when ADMIN_EMAIL/ADMIN_PASSWORD are unset", async () => {
    const email = emailFor("unset");
    vi.stubEnv("ADMIN_EMAIL", "");
    vi.stubEnv("ADMIN_PASSWORD", "");

    await bootstrapFirstAdmin(NO_ACTIVE_ADMIN);

    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });
});
