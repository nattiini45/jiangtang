import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { updateUser, assertCanChangeAdminStatus } from "~/domains/auth/users.queries.server";
import { pseudonymizeUser } from "~/domains/auth/gdpr.server";

/**
 * Last-admin / self-demotion lockout guard. Verifies:
 *   (a) updateUser demoting/deactivating the sole remaining active admin throws;
 *   (b) an admin can't demote/deactivate THEMSELVES via updateUser;
 *   (c) pseudonymizeUser on the last active admin throws (erasure deactivates).
 *
 * The guard's "last admin" check counts ALL other active admins in the table,
 * so — since this runs against a shared dev/test DB that may already have a
 * seeded admin — each test that needs a true "last admin" scenario temporarily
 * deactivates any other active admins for its duration and restores them in a
 * `finally`. This never touches ActivityLog directly and uses only ordinary
 * (non-transactional) Prisma calls, per the app/domains guard script.
 */

const ACTOR = { id: "system", name: "Test", email: "t@t", initials: "TT" };
const createdUserIds: string[] = [];

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.session.deleteMany({ where: { userId: id } });
    await db.account.deleteMany({ where: { userId: id } });
    await db.activityLog.deleteMany({ where: { actorId: id } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id } }).catch(() => undefined);
  }
  await db.$disconnect();
});

async function createAdmin(label: string) {
  const user = await db.user.create({
    data: {
      name: `Guard ${label}`,
      email: `guard_${label}_${Date.now()}_${Math.random().toString(36).slice(2)}@jiangtang.local`,
      initials: null,
      role: "ADMIN",
      isActive: true,
      emailVerified: true,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

/** Temporarily deactivates every OTHER active admin, runs `fn`, then restores them. */
async function withOnlyThisAdminActive<T>(keepId: string, fn: () => Promise<T>): Promise<T> {
  const others = await db.user.findMany({
    where: { id: { not: keepId }, role: "ADMIN", isActive: true },
    select: { id: true },
  });
  const otherIds = others.map((o) => o.id);
  if (otherIds.length > 0) {
    await db.user.updateMany({ where: { id: { in: otherIds } }, data: { isActive: false } });
  }
  try {
    return await fn();
  } finally {
    if (otherIds.length > 0) {
      await db.user.updateMany({ where: { id: { in: otherIds } }, data: { isActive: true } });
    }
  }
}

describe("assertCanChangeAdminStatus / updateUser lockout guard", () => {
  it("demoting the last active admin throws", async () => {
    const admin = await createAdmin("last-demote");
    await withOnlyThisAdminActive(admin.id, async () => {
      await expect(
        updateUser(
          admin.id,
          { role: "MEMBER", initials: "XX", isActive: true, weeklyCapacityHours: null },
          ACTOR,
        ),
      ).rejects.toThrow();

      // Unchanged in the DB.
      const persisted = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(persisted.role).toBe("ADMIN");
    });
  });

  it("deactivating the last active admin throws", async () => {
    const admin = await createAdmin("last-deactivate");
    await withOnlyThisAdminActive(admin.id, async () => {
      await expect(
        updateUser(
          admin.id,
          { role: "ADMIN", initials: "XX", isActive: false, weeklyCapacityHours: null },
          ACTOR,
        ),
      ).rejects.toThrow();

      const persisted = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(persisted.isActive).toBe(true);
    });
  });

  it("an admin cannot demote/deactivate THEMSELVES via updateUser, even if other admins exist", async () => {
    const admin = await createAdmin("self");
    const other = await createAdmin("self-other");
    const selfActor = {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      initials: admin.initials,
    };

    await expect(
      updateUser(
        admin.id,
        { role: "MEMBER", initials: "XX", isActive: true, weeklyCapacityHours: null },
        selfActor,
      ),
    ).rejects.toThrow();
    await expect(
      updateUser(
        admin.id,
        { role: "ADMIN", initials: "XX", isActive: false, weeklyCapacityHours: null },
        selfActor,
      ),
    ).rejects.toThrow();

    const persisted = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(persisted.role).toBe("ADMIN");
    expect(persisted.isActive).toBe(true);
    void other;
  });

  it("demoting/deactivating a non-last admin succeeds (control case)", async () => {
    const admin = await createAdmin("control");
    await createAdmin("control-other"); // ensures at least one other active admin
    await updateUser(
      admin.id,
      { role: "MEMBER", initials: "CT", isActive: true, weeklyCapacityHours: null },
      ACTOR,
    );
    const persisted = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(persisted.role).toBe("MEMBER");
  });

  it("editing a non-admin (or an already-inactive admin) never triggers the guard", async () => {
    const member = await db.user.create({
      data: {
        name: "Guard Member",
        email: `guard_member_${Date.now()}@jiangtang.local`,
        role: "MEMBER",
        isActive: true,
        emailVerified: true,
      },
    });
    createdUserIds.push(member.id);
    await expect(
      updateUser(
        member.id,
        { role: "MEMBER", initials: "MM", isActive: false, weeklyCapacityHours: null },
        ACTOR,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("pseudonymizeUser applies the same lockout guard", () => {
  it("erasing the last active admin throws and leaves the row untouched", async () => {
    const admin = await createAdmin("erase-last");
    await withOnlyThisAdminActive(admin.id, async () => {
      await expect(pseudonymizeUser(ACTOR, admin.id)).rejects.toThrow();

      const persisted = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
      expect(persisted.isActive).toBe(true);
      expect(persisted.name).not.toBe("[pseudonymisiert]");
    });
  });

  it("an admin cannot erase THEMSELVES, even if other admins exist", async () => {
    const admin = await createAdmin("erase-self");
    await createAdmin("erase-self-other");
    const selfActor = {
      id: admin.id,
      name: admin.name,
      email: admin.email,
      initials: admin.initials,
    };

    await expect(pseudonymizeUser(selfActor, admin.id)).rejects.toThrow();

    const persisted = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(persisted.isActive).toBe(true);
    expect(persisted.name).not.toBe("[pseudonymisiert]");
  });

  it("erasing a non-last admin succeeds (control case)", async () => {
    const admin = await createAdmin("erase-control");
    await createAdmin("erase-control-other");
    const result = await pseudonymizeUser(ACTOR, admin.id);
    expect(result.userId).toBe(admin.id);

    const persisted = await db.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(persisted.isActive).toBe(false);
    expect(persisted.name).toBe("[pseudonymisiert]");
    expect(persisted.email).toBe(`erased-${admin.id}@erased.local`);
  });
});

describe("assertCanChangeAdminStatus (unit-ish, via db directly since it needs a Tx)", () => {
  it("is a no-op for a MEMBER target regardless of the requested change", async () => {
    const member = await db.user.create({
      data: {
        name: "Guard Member 2",
        email: `guard_member2_${Date.now()}@jiangtang.local`,
        role: "MEMBER",
        isActive: true,
        emailVerified: true,
      },
    });
    createdUserIds.push(member.id);
    // db itself satisfies the Tx (Prisma.TransactionClient) structural type for reads.
    await expect(
      assertCanChangeAdminStatus(db as never, member.id, ACTOR, {
        role: "MEMBER",
        isActive: false,
      }),
    ).resolves.toBeUndefined();
  });
});
