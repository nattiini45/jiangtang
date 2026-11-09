import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { NotFoundError } from "~/lib/errors.server";
import {
  authenticatePersonalAccessToken,
  createPersonalAccessToken,
  listPersonalAccessTokens,
  revokePersonalAccessToken,
} from "~/domains/api-tokens/api-tokens.server";
import { tokenCreateSchema, type TokenActor } from "~/domains/api-tokens/api-tokens.schema";

const RUN = `pat_${randomUUID()}`;
const users: TokenActor[] = [];
let member: TokenActor;
let other: TokenActor;
let admin: TokenActor;
const originalTwoFactorPolicy = process.env.REQUIRE_ADMIN_TWO_FACTOR;

beforeAll(async () => {
  for (const role of ["MEMBER", "MEMBER", "ADMIN"] as const) {
    const user = await db.user.create({
      data: { email: `${RUN}-${users.length}@jiangtang.test`, name: `${RUN} ${role}`, role },
    });
    users.push(user);
  }
  [member, other, admin] = users as [TokenActor, TokenActor, TokenActor];
});

afterEach(async () => {
  if (originalTwoFactorPolicy === undefined) delete process.env.REQUIRE_ADMIN_TWO_FACTOR;
  else process.env.REQUIRE_ADMIN_TWO_FACTOR = originalTwoFactorPolicy;
  await db.user.updateMany({
    where: { id: { in: users.map((user) => user.id) } },
    data: { isActive: true, twoFactorEnabled: false },
  });
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await db.$disconnect();
});

describe("personal access token creation", () => {
  it("requires configured admin 2FA for other accounts' token management, not own setup", async () => {
    process.env.REQUIRE_ADMIN_TWO_FACTOR = "true";
    const target = await createPersonalAccessToken(member, {
      name: "Other account",
      scope: "READ_ONLY",
    });
    const own = await createPersonalAccessToken(admin, { name: "Own setup", scope: "READ_ONLY" });
    await expect(listPersonalAccessTokens(admin, { all: true })).rejects.toMatchObject({
      status: 403,
    });
    await expect(revokePersonalAccessToken(admin, target.record.id)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await db.personalAccessToken.findUniqueOrThrow({ where: { id: target.record.id } }))
        .revokedAt,
    ).toBeNull();
    expect(await listPersonalAccessTokens(admin)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: own.record.id })]),
    );
    await expect(revokePersonalAccessToken(admin, own.record.id)).resolves.toMatchObject({
      id: own.record.id,
      revokedAt: expect.any(Date),
    });
    await db.user.update({ where: { id: admin.id }, data: { twoFactorEnabled: true } });
    const enrolled = { ...admin, twoFactorEnabled: true };
    await expect(listPersonalAccessTokens(enrolled, { all: true })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: target.record.id })]),
    );
    await expect(revokePersonalAccessToken(enrolled, target.record.id)).resolves.toMatchObject({
      revokedAt: expect.any(Date),
    });
  });
  it("validates names and the two supported scopes", () => {
    expect(tokenCreateSchema.parse({ name: "  Synthetic client  ", scope: "READ_ONLY" })).toEqual({
      name: "Synthetic client",
      scope: "READ_ONLY",
    });
    for (const name of ["", "  ", "a".repeat(121)]) {
      expect(tokenCreateSchema.safeParse({ name, scope: "READ_ONLY" }).success).toBe(false);
    }
    expect(tokenCreateSchema.safeParse({ name: "Client", scope: "ADMIN" }).success).toBe(false);
    expect(tokenCreateSchema.safeParse({ name: "Client" }).success).toBe(false);
  });

  it("returns a 256-bit secret once and persists only its SHA-256 hash", async () => {
    const created = await createPersonalAccessToken(member, {
      name: "  Reader  ",
      scope: "READ_ONLY",
    });
    const second = await createPersonalAccessToken(member, { name: "Reader", scope: "READ_ONLY" });
    expect(created.token).toMatch(/^jtg_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(created.token.slice(4), "base64url")).toHaveLength(32);
    expect(created.token).not.toBe(second.token);
    const stored = await db.personalAccessToken.findUniqueOrThrow({
      where: { id: created.record.id },
    });
    expect(stored.tokenHash).toBe(createHash("sha256").update(created.token).digest("hex"));
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.record).toEqual({
      id: stored.id,
      userId: member.id,
      name: "Reader",
      scope: "READ_ONLY",
      createdAt: expect.any(Date),
      revokedAt: null,
      lastUsedAt: null,
    });
    expect(JSON.stringify(stored)).not.toContain(created.token);
    const audit = await db.activityLog.findFirstOrThrow({
      where: {
        action: "PersonalAccessTokenCreated",
        entityType: "user",
        entityId: member.id,
        data: { path: ["tokenId"], equals: stored.id },
      },
    });
    expect(audit.actorId).toBe(member.id);
    expect(audit.data).toEqual({ tokenId: stored.id, name: "Reader", scope: "READ_ONLY" });
    expect(JSON.stringify(audit)).not.toContain(created.token);
    expect(JSON.stringify(audit)).not.toContain(stored.tokenHash);
  });

  it("rejects invalid input in the mutation without creating a token or audit", async () => {
    const before = await db.personalAccessToken.count({ where: { userId: member.id } });
    const auditsBefore = await db.activityLog.count({ where: { entityId: member.id } });
    await expect(
      createPersonalAccessToken(member, { name: " ", scope: "READ_ONLY" }),
    ).rejects.toThrow();
    expect(await db.personalAccessToken.count({ where: { userId: member.id } })).toBe(before);
    expect(await db.activityLog.count({ where: { entityId: member.id } })).toBe(auditsBefore);
  });
});

describe("token ownership and revocation", () => {
  it("lists only owned metadata and supplies safe owner labels for admin listing", async () => {
    const mine = await createPersonalAccessToken(member, { name: "Mine", scope: "READ_WRITE" });
    const theirs = await createPersonalAccessToken(other, { name: "Theirs", scope: "READ_ONLY" });
    const own = await listPersonalAccessTokens(member);
    expect(own.some((token) => token.id === mine.record.id)).toBe(true);
    expect(own.every((token) => token.userId === member.id)).toBe(true);
    expect(own.some((token) => token.id === theirs.record.id)).toBe(false);
    await expect(listPersonalAccessTokens(member, { all: true })).rejects.toMatchObject({
      status: 403,
    });
    const all = await listPersonalAccessTokens(admin, { all: true });
    expect(all.find((token) => token.id === theirs.record.id)?.owner).toEqual({
      id: other.id,
      name: other.name,
    });
    expect(all.find((token) => token.id === mine.record.id)?.scope).toBe("READ_WRITE");
    for (const row of all) {
      expect(row).not.toHaveProperty("tokenHash");
      expect(row).not.toHaveProperty("token");
      expect(row.owner).not.toHaveProperty("email");
    }
  });

  it("refuses another member's revocation without modifying or auditing it", async () => {
    const created = await createPersonalAccessToken(member, {
      name: "Protected",
      scope: "READ_ONLY",
    });
    await expect(revokePersonalAccessToken(other, created.record.id)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await db.personalAccessToken.findUniqueOrThrow({ where: { id: created.record.id } }))
        .revokedAt,
    ).toBeNull();
    expect(
      await db.activityLog.count({
        where: {
          action: "PersonalAccessTokenRevoked",
          data: { path: ["tokenId"], equals: created.record.id },
        },
      }),
    ).toBe(0);
  });

  it("lets owners revoke, retains metadata, and audits repeated revocation only once", async () => {
    const created = await createPersonalAccessToken(member, {
      name: "Revoke own",
      scope: "READ_WRITE",
    });
    const revoked = await revokePersonalAccessToken(member, created.record.id);
    expect(revoked.revokedAt).toBeInstanceOf(Date);
    expect(revoked).not.toHaveProperty("tokenHash");
    expect(await authenticatePersonalAccessToken(created.token)).toBeNull();
    expect(await revokePersonalAccessToken(member, created.record.id)).toEqual(revoked);
    const audits = await db.activityLog.findMany({
      where: {
        action: "PersonalAccessTokenRevoked",
        data: { path: ["tokenId"], equals: created.record.id },
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: member.id,
      entityType: "user",
      entityId: member.id,
    });
    expect(
      (await listPersonalAccessTokens(member)).find((row) => row.id === created.record.id)
        ?.revokedAt,
    ).toEqual(revoked.revokedAt);
  });

  it("lets admins revoke another user's token while auditing the owner entity", async () => {
    const created = await createPersonalAccessToken(member, {
      name: "Admin revoke",
      scope: "READ_ONLY",
    });
    await revokePersonalAccessToken(admin, created.record.id);
    expect(await authenticatePersonalAccessToken(created.token)).toBeNull();
    const audit = await db.activityLog.findFirstOrThrow({
      where: {
        action: "PersonalAccessTokenRevoked",
        data: { path: ["tokenId"], equals: created.record.id },
      },
    });
    expect(audit).toMatchObject({ actorId: admin.id, entityId: member.id, entityType: "user" });
    await expect(revokePersonalAccessToken(admin, "missing-token")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("token authentication", () => {
  it("rejects unknown and malformed secrets", async () => {
    for (const raw of ["", "jtg_short", `jtg_${"a".repeat(43)}`, `other_${"a".repeat(43)}`]) {
      expect(await authenticatePersonalAccessToken(raw)).toBeNull();
    }
  });

  it.each(["READ_ONLY", "READ_WRITE"] as const)(
    "preserves the %s scope and updates last-used without audit",
    async (scope) => {
      const created = await createPersonalAccessToken(member, { name: "Scope client", scope });
      const auditsBefore = await db.activityLog.count({ where: { entityId: member.id } });
      const authenticated = await authenticatePersonalAccessToken(created.token);
      expect(authenticated?.token).toEqual({ id: created.record.id, name: "Scope client", scope });
      expect(authenticated?.user).toMatchObject({
        id: member.id,
        role: "MEMBER",
        isActive: true,
        twoFactorEnabled: false,
      });
      expect(authenticated).not.toHaveProperty("tokenHash");
      const stored = await db.personalAccessToken.findUniqueOrThrow({
        where: { id: created.record.id },
      });
      expect(stored.lastUsedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(authenticated)).not.toContain(stored.tokenHash);
      expect(await db.activityLog.count({ where: { entityId: member.id } })).toBe(auditsBefore);
      await db.user.update({ where: { id: member.id }, data: { name: `${RUN} Fresh name` } });
      expect((await authenticatePersonalAccessToken(created.token))?.user.name).toBe(
        `${RUN} Fresh name`,
      );
    },
  );

  it("refuses a freshly disabled user without updating last-used", async () => {
    const created = await createPersonalAccessToken(member, {
      name: "Disabled",
      scope: "READ_ONLY",
    });
    await db.user.update({ where: { id: member.id }, data: { isActive: false } });
    expect(await authenticatePersonalAccessToken(created.token)).toBeNull();
    expect(
      (await db.personalAccessToken.findUniqueOrThrow({ where: { id: created.record.id } }))
        .lastUsedAt,
    ).toBeNull();
  });

  it("enforces admin two-factor policy using fresh user state", async () => {
    const created = await createPersonalAccessToken(admin, {
      name: "Admin policy",
      scope: "READ_ONLY",
    });
    const memberToken = await createPersonalAccessToken(member, {
      name: "Member policy",
      scope: "READ_ONLY",
    });
    process.env.REQUIRE_ADMIN_TWO_FACTOR = "true";
    expect(await authenticatePersonalAccessToken(created.token)).toBeNull();
    expect(await authenticatePersonalAccessToken(memberToken.token)).not.toBeNull();
    await db.user.update({ where: { id: admin.id }, data: { twoFactorEnabled: true } });
    expect((await authenticatePersonalAccessToken(created.token))?.user.twoFactorEnabled).toBe(
      true,
    );
    await db.user.update({ where: { id: admin.id }, data: { twoFactorEnabled: false } });
    expect(await authenticatePersonalAccessToken(created.token)).toBeNull();
    process.env.REQUIRE_ADMIN_TWO_FACTOR = "false";
    expect(await authenticatePersonalAccessToken(created.token)).not.toBeNull();
  });

  it("stores every operational timestamp with a time zone", async () => {
    const columns = await db.$queryRaw<Array<{ column_name: string; data_type: string }>>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'PersonalAccessToken'
        AND column_name IN ('createdAt', 'revokedAt', 'lastUsedAt')
      ORDER BY column_name
    `;
    expect(columns).toEqual(
      ["createdAt", "lastUsedAt", "revokedAt"].map((column_name) => ({
        column_name,
        data_type: "timestamp with time zone",
      })),
    );
  });
});
