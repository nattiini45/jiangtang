import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { updateUser } from "~/domains/auth/users.queries.server";

/**
 * Deactivating a user ends that user's sessions once the change has committed,
 * and leaves other users' sessions alone. Rows are namespaced by RUN and
 * removed in afterAll; the audit rows the update writes are append-only and stay.
 */

const RUN = `t_deact_${Date.now()}`;
const ACTOR = { id: "system", name: "Test", email: "t@t", initials: "TT" };
const createdUserIds: string[] = [];

function randomInitials(): string {
  return Array.from({ length: 3 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join("");
}

async function memberWithSession(label: string): Promise<{ id: string }> {
  const user = await db.user.create({
    data: {
      name: `Deactivation ${label}`,
      email: `${RUN}_${label}@jiangtang.local`,
      role: "MEMBER",
      isActive: true,
      emailVerified: true,
      initials: null,
    },
    select: { id: true },
  });
  createdUserIds.push(user.id);
  await db.session.create({
    data: {
      token: `${RUN}_${label}_token`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  return user;
}

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.session.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.account.deleteMany({ where: { userId: id } }).catch(() => undefined);
    await db.user.delete({ where: { id } }).catch(() => undefined);
  }
  await db.$disconnect();
});

describe("updateUser deactivation", () => {
  it("deletes the deactivated user's sessions and leaves other users' sessions alone", async () => {
    const target = await memberWithSession("target");
    const bystander = await memberWithSession("bystander");
    expect(await db.session.count({ where: { userId: target.id } })).toBe(1);

    await updateUser(
      target.id,
      { role: "MEMBER", initials: randomInitials(), isActive: false, weeklyCapacityHours: null },
      ACTOR,
    );

    const persisted = await db.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(persisted.isActive).toBe(false);
    expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: bystander.id } })).toBe(1);
  });

  it("keeps sessions when the user stays active", async () => {
    const user = await memberWithSession("stays-active");

    await updateUser(
      user.id,
      { role: "MEMBER", initials: randomInitials(), isActive: true, weeklyCapacityHours: null },
      ACTOR,
    );

    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });
});
