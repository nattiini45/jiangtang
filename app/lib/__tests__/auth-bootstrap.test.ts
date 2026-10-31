import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { bootstrapFirstAdmin } from "~/lib/auth-bootstrap.server";

/**
 * First-admin bootstrap (T-AUTH). Verifies: with env set it creates one ADMIN
 * with emailVerified/isActive + derived initials; a second call is idempotent
 * (no duplicate, no throw); with env unset it creates nothing.
 *
 * Shared dev DB — every row this test creates is namespaced by RUN and removed
 * in afterAll (FK order: Session/Account → User). ActivityLog rows are
 * append-only, so the `UserBootstrapped` audit rows this suite provokes are
 * asserted and left in place, never deleted.
 */

const RUN = `t_authboot_${Date.now()}`;
const ADMIN_EMAIL = `${RUN}@jiangtang.local`;
const ADMIN_PASSWORD = "bootstrap-pw-123";

async function deleteUserByEmail(email: string): Promise<void> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) return;
  await db.session.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
  await db.account.deleteMany({ where: { userId: user.id } }).catch(() => undefined);
  await db.user.delete({ where: { id: user.id } }).catch(() => undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await deleteUserByEmail(ADMIN_EMAIL);
  await db.$disconnect();
});

describe("bootstrapFirstAdmin", () => {
  it("creates an ADMIN with emailVerified + derived initials when env is set", async () => {
    vi.stubEnv("ADMIN_EMAIL", ADMIN_EMAIL);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
    // Pin the derivation branch: the dev .env sets ADMIN_INITIALS, and an
    // un-stubbed ambient value silently takes the explicit branch instead.
    vi.stubEnv("ADMIN_INITIALS", "");

    await bootstrapFirstAdmin();

    const user = await db.user.findUnique({ where: { email: ADMIN_EMAIL } });
    expect(user).not.toBeNull();
    expect(user?.role).toBe("ADMIN");
    expect(user?.emailVerified).toBe(true);
    expect(user?.isActive).toBe(true);
    // derived from local part "t_authboot_<ts>" → alnum, uppercased, first 3 chars.
    expect(user?.initials).toBe("TAU");

    // The domain-field update carries an audit row like every mutation.
    const auditRows = await db.activityLog.findMany({
      where: { action: "UserBootstrapped", entityType: "user", entityId: user!.id },
    });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorSnapshot).toMatchObject({ name: "system" });
  });

  it("prefers an explicit ADMIN_INITIALS over the derived value", async () => {
    const explicitEmail = `${RUN}_explicit@jiangtang.local`;
    vi.stubEnv("ADMIN_EMAIL", explicitEmail);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);
    vi.stubEnv("ADMIN_INITIALS", "zc");

    try {
      await bootstrapFirstAdmin();
      const user = await db.user.findUnique({ where: { email: explicitEmail } });
      expect(user?.initials).toBe("ZC");
    } finally {
      await deleteUserByEmail(explicitEmail);
    }
  });

  it("is idempotent — a second call creates no duplicate and does not throw", async () => {
    vi.stubEnv("ADMIN_EMAIL", ADMIN_EMAIL);
    vi.stubEnv("ADMIN_PASSWORD", ADMIN_PASSWORD);

    await expect(bootstrapFirstAdmin()).resolves.toBeUndefined();

    const users = await db.user.findMany({ where: { email: ADMIN_EMAIL } });
    expect(users).toHaveLength(1);
  });

  it("creates no user when ADMIN_EMAIL/ADMIN_PASSWORD are unset", async () => {
    const unsetEmail = `${RUN}_unset@jiangtang.local`;
    vi.stubEnv("ADMIN_EMAIL", "");
    vi.stubEnv("ADMIN_PASSWORD", "");

    await bootstrapFirstAdmin();

    const user = await db.user.findUnique({ where: { email: unsetEmail } });
    expect(user).toBeNull();
  });
});
