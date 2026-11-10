import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import {
  acceptInvite,
  changeInvitation,
  createInvite,
  listInvitations,
  resolveInvite,
} from "~/domains/auth/users.queries.server";

const prefix = `invitations-${crypto.randomUUID()}`;
const actor = { name: "Synthetic inviter" };
const emails: string[] = [];

async function invite() {
  const email = `${prefix}-${emails.length}@example.test`;
  emails.push(email);
  const token = await createInvite(
    {
      email,
      name: "Synthetic invitee",
      initials: `ZV${String.fromCharCode(65 + emails.length)}`,
      role: "MEMBER",
    },
    actor,
  );
  return { token, record: await resolveInvite(token) };
}

afterAll(async () => {
  const users = { email: { in: emails } };
  await db.account.deleteMany({ where: { user: users } });
  await db.user.deleteMany({ where: users });
  await db.invitation.deleteMany({ where: { email: { in: emails } } });
  await db.verification.deleteMany({ where: { identifier: { in: emails } } });
});

describe("invitation lifecycle", () => {
  it("lists metadata without a recoverable link and audits creation", async () => {
    const { token, record } = await invite();
    const row = (await listInvitations()).find((row) => row.id === record.id)!;
    expect(row).toMatchObject({ state: "pending", name: "Synthetic invitee", role: "MEMBER" });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeCloseTo(7 * 86400000, -3);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).not.toHaveProperty("tokenHash");
    const stored = await db.invitation.findUniqueOrThrow({ where: { id: record.id } });
    expect(stored.tokenHash).toHaveLength(64);
    expect(stored.tokenHash).not.toBe(token);
    const log = await db.activityLog.findFirstOrThrow({
      where: { entityId: row.email, action: "UserInvited" },
    });
    expect(JSON.stringify(log)).not.toContain(token);
  });

  it("revokes immediately, including a previously resolved invitation", async () => {
    const { token, record } = await invite();
    await changeInvitation(record.id, "revoke", actor);
    await expect(resolveInvite(token)).rejects.toThrow();
    await expect(acceptInvite(record, "a-valid-password-1")).rejects.toThrow();
    await expect(changeInvitation(record.id, "reissue", actor)).rejects.toThrow();
    expect((await listInvitations()).find((row) => row.id === record.id)?.state).toBe("revoked");
    expect(await db.user.count({ where: { email: record.email } })).toBe(0);
    expect(
      await db.activityLog.count({
        where: { action: "InvitationRevoked", entityId: record.email },
      }),
    ).toBe(1);
  });

  it("rotates pending and expired links, retains acceptance and leaves email unverified", async () => {
    const { token, record } = await invite();
    const rotated = (await changeInvitation(record.id, "reissue", actor))!;
    await expect(resolveInvite(token)).rejects.toThrow();
    await expect(acceptInvite(record, "a-valid-password-1")).rejects.toThrow();
    await db.invitation.update({
      where: { id: record.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(resolveInvite(rotated)).rejects.toThrow();
    expect((await listInvitations()).find((row) => row.id === record.id)?.state).toBe("expired");
    const fresh = (await changeInvitation(record.id, "reissue", actor))!;
    await expect(resolveInvite(rotated)).rejects.toThrow();
    const user = await acceptInvite(await resolveInvite(fresh), "a-valid-password-1");
    expect(await db.user.findUnique({ where: { id: user.id } })).toMatchObject({
      emailVerified: false,
    });
    const row = (await listInvitations()).find((row) => row.id === record.id)!;
    expect(row.state).toBe("accepted");
    expect(row.acceptedAt).toBeInstanceOf(Date);
    await expect(resolveInvite(fresh)).rejects.toThrow();
    await expect(changeInvitation(record.id, "revoke", actor)).rejects.toThrow();
    expect(
      await db.activityLog.count({
        where: { action: "InvitationReissued", entityId: record.email },
      }),
    ).toBe(2);
  });

  it("concurrent re-issues leave only one working link", async () => {
    const { record } = await invite();
    const tokens = await Promise.all([
      changeInvitation(record.id, "reissue", actor),
      changeInvitation(record.id, "reissue", actor),
    ]);
    const results = await Promise.allSettled(tokens.map((token) => resolveInvite(token!)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("a new invitation supersedes older links without losing their history", async () => {
    const { token, record } = await invite();
    const fresh = await createInvite(
      { email: record.email, name: "Replacement", initials: record.initials, role: "ADMIN" },
      actor,
    );
    await expect(resolveInvite(token)).rejects.toThrow();
    expect(await resolveInvite(fresh)).toMatchObject({ role: "ADMIN" });
    expect((await listInvitations()).find((row) => row.id === record.id)?.state).toBe("revoked");
  });

  it("imports legacy links without changing the previous release's Verification storage", async () => {
    const email = `${prefix}-legacy@example.test`;
    emails.push(email);
    const token = crypto.randomUUID();
    const old = await db.verification.create({
      data: {
        identifier: email,
        value: JSON.stringify({ token, email, name: "Legacy", initials: "ZVI", role: "MEMBER" }),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const sql = readFileSync(
      new URL(
        "../../../../prisma/migrations/20261110203000_invitations/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.$executeRawUnsafe(sql.slice(sql.indexOf("DO $$")));
    expect(await resolveInvite(token)).toMatchObject({ id: old.id, email });
    expect(await db.verification.findUnique({ where: { id: old.id } })).not.toBeNull();
    await changeInvitation(old.id, "revoke", actor);
    expect(await db.verification.findUnique({ where: { id: old.id } })).toBeNull();
    await expect(resolveInvite(token)).rejects.toThrow();
  });
});
