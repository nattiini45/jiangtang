import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db, type Tx } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { auth } from "~/lib/auth.server";
import * as realtime from "~/lib/realtime/emit.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import {
  authenticatePersonalAccessToken,
  createPersonalAccessToken,
  revokePersonalAccessToken,
} from "~/domains/api-tokens/api-tokens.server";
import { updateUser } from "~/domains/auth/users.queries.server";
import { pseudonymizeUser } from "~/domains/auth/gdpr.server";
import {
  completePasswordReset,
  createPasswordReset,
  createPasswordResetForEmail,
  resolvePasswordReset,
} from "~/domains/auth/password-reset.server";

const fault = vi.hoisted(() => ({ action: "" }));
vi.mock("~/lib/audit.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/audit.server")>();
  const wrapped: typeof actual.txWithAudit = (actor, fn, options) =>
    actual.txWithAudit(
      actor,
      (tx, audit) =>
        fn(tx, async (input) => {
          await audit(input);
          if (input.action === fault.action) throw new Error("Synthetic audit failure");
        }),
      options,
    );
  return { ...actual, txWithAudit: wrapped };
});

const operator = { name: "Synthetic operator" };
const ids: string[] = [];
const originalTwoFactorPolicy = process.env.REQUIRE_ADMIN_TWO_FACTOR;

async function owner() {
  const initials = Array.from(randomUUID().slice(0, 6), (digit) =>
    String.fromCharCode(65 + Number.parseInt(digit, 16)),
  ).join("");
  const user = await db.user.create({
    data: { name: "Synthetic owner", email: `${randomUUID()}@example.test`, initials },
  });
  ids.push(user.id);
  await db.account.create({
    data: {
      userId: user.id,
      accountId: user.id,
      providerId: "credential",
      password: "synthetic-old-hash",
    },
  });
  await db.session.create({
    data: { userId: user.id, token: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return user;
}

type Owner = Awaited<ReturnType<typeof owner>>;
const issue = (user: Owner) =>
  createPersonalAccessToken(user, { name: "Synthetic private client name", scope: "READ_WRITE" });
const edit = (user: Owner, isActive: boolean) =>
  updateUser(
    user.id,
    { role: user.role, initials: user.initials!, isActive, weeklyCapacityHours: null },
    operator,
  );
const revocations = (userId: string) =>
  db.activityLog.findMany({
    where: { entityType: "user", entityId: userId, action: "PersonalAccessTokenRevoked" },
    orderBy: { insertedAt: "asc" },
  });
const tokenRow = (id: string) => db.personalAccessToken.findUniqueOrThrow({ where: { id } });

afterEach(() => {
  vi.restoreAllMocks();
  fault.action = "";
  if (originalTwoFactorPolicy === undefined) delete process.env.REQUIRE_ADMIN_TWO_FACTOR;
  else process.env.REQUIRE_ADMIN_TWO_FACTOR = originalTwoFactorPolicy;
});

afterAll(async () => {
  await db.verification.deleteMany({ where: { value: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

const boundaries = ["deactivation", "erasure", "reset issuance", "reset completion"] as const;
type Boundary = (typeof boundaries)[number];
const reasonFor = {
  deactivation: "USER_DEACTIVATED",
  erasure: "USER_PSEUDONYMIZED",
  "reset issuance": "PASSWORD_RESET_ISSUED",
  "reset completion": "PASSWORD_RESET_COMPLETED",
} as const;
const auditFor = {
  deactivation: "UserUpdated",
  erasure: "UserPseudonymized",
  "reset issuance": "PasswordResetIssued",
  "reset completion": "PasswordReset",
} as const;

async function lifecycle(boundary: Boundary, user: Owner) {
  const reset =
    boundary === "reset completion" ? await createPasswordReset(user.id, operator) : null;
  return () => {
    switch (boundary) {
      case "deactivation":
        return edit(user, false);
      case "erasure":
        return pseudonymizeUser(operator, user.id);
      case "reset issuance":
        return createPasswordReset(user.id, operator);
      case "reset completion":
        return completePasswordReset(reset!, "synthetic-new-password");
    }
  };
}

describe("PAT account lifecycle policy", () => {
  it.each(boundaries)(
    "%s revokes only live owned PATs with safe, attributed audit",
    async (boundary) => {
      const user = await owner();
      const other = await owner();
      const run = await lifecycle(boundary, user);
      const first = await issue(user);
      const second = await createPersonalAccessToken(user, { name: "Reader", scope: "READ_ONLY" });
      const alreadyRevoked = await issue(user);
      await revokePersonalAccessToken(user, alreadyRevoked.record.id);
      const oldRevocation = await tokenRow(alreadyRevoked.record.id);
      const unrelated = await issue(other);
      await run();

      const logs = await revocations(user.id);
      expect(logs).toHaveLength(3);
      for (const created of [first, second]) {
        expect((await tokenRow(created.record.id)).revokedAt).toBeInstanceOf(Date);
        expect(await authenticatePersonalAccessToken(created.token)).toBeNull();
        expect(
          logs.find((row) => (row.data as { tokenId: string }).tokenId === created.record.id),
        ).toMatchObject({
          actorId: boundary === "reset completion" ? user.id : null,
          actorSnapshot: { name: boundary === "reset completion" ? user.name : operator.name },
          entityType: "user",
          entityId: user.id,
          data: {
            tokenId: created.record.id,
            scope: created.record.scope,
            reason: reasonFor[boundary],
          },
        });
        const encoded = JSON.stringify(
          logs.filter((row) => (row.data as { tokenId: string }).tokenId === created.record.id),
        );
        expect(encoded).not.toContain(created.token);
        expect(encoded).not.toContain(createHash("sha256").update(created.token).digest("hex"));
        expect(encoded).not.toContain(created.record.name);
      }
      expect((await tokenRow(alreadyRevoked.record.id)).revokedAt).toEqual(oldRevocation.revokedAt);
      expect((await tokenRow(unrelated.record.id)).revokedAt).toBeNull();
      expect(await authenticatePersonalAccessToken(unrelated.token)).not.toBeNull();
      expect(await revocations(other.id)).toEqual([]);

      if (boundary === "deactivation" || boundary === "erasure") {
        await run();
        await edit(user, true);
        expect(await authenticatePersonalAccessToken(first.token)).toBeNull();
      } else if (boundary === "reset issuance") {
        await run();
      } else {
        await expect(run()).rejects.toBeInstanceOf(NotFoundError);
      }
      expect(await revocations(user.id)).toHaveLength(3);
    },
  );

  it("reset issuance keeps credentials, sessions and 2FA; completion revokes window PATs and sessions", async () => {
    const user = await owner();
    await db.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
    const twoFactor = await db.twoFactor.create({
      data: { userId: user.id, secret: "synthetic-encrypted", backupCodes: "synthetic-codes" },
    });
    const before = await issue(user);
    const reset = await createPasswordReset(user.id, operator);
    expect((await tokenRow(before.record.id)).revokedAt).toBeInstanceOf(Date);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    expect((await db.account.findFirstOrThrow({ where: { userId: user.id } })).password).toBe(
      "synthetic-old-hash",
    );
    expect(await resolvePasswordReset(reset)).toMatchObject({ userId: user.id });
    const window = await issue(user);
    expect(await authenticatePersonalAccessToken(window.token)).not.toBeNull();
    await completePasswordReset(reset, "synthetic-new-password");
    expect(await authenticatePersonalAccessToken(window.token)).toBeNull();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    expect((await db.account.findFirstOrThrow({ where: { userId: user.id } })).password).not.toBe(
      "synthetic-old-hash",
    );
    expect(await db.twoFactor.findUniqueOrThrow({ where: { id: twoFactor.id } })).toEqual(
      twoFactor,
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(
      true,
    );
    await expect(completePasswordReset(reset, "synthetic-repeat-password")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await revocations(user.id)).toHaveLength(2);
    expect(
      await db.activityLog.findFirstOrThrow({
        where: { entityId: user.id, action: "PasswordReset" },
      }),
    ).toMatchObject({ actorId: user.id, data: { sessionsRevoked: true } });
    expect(await authenticatePersonalAccessToken((await issue(user)).token)).not.toBeNull();
  });

  it("the operator email entry revokes PATs and replaces the previous reset link", async () => {
    const user = await owner();
    const previous = await createPasswordReset(user.id, operator);
    const pat = await issue(user);
    const { token } = await createPasswordResetForEmail(` ${user.email.toUpperCase()} `, operator);
    expect(await authenticatePersonalAccessToken(pat.token)).toBeNull();
    await expect(resolvePasswordReset(previous)).rejects.toBeInstanceOf(NotFoundError);
    expect(await resolvePasswordReset(token)).toMatchObject({ userId: user.id });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it.each(["invalid", "expired", "replaced"])(
    "%s reset completion does not revoke a window PAT or alter credentials/sessions",
    async (kind) => {
      const user = await owner();
      let reset = await createPasswordReset(user.id, operator);
      if (kind === "invalid") reset = "f".repeat(64);
      if (kind === "expired")
        await db.verification.updateMany({
          where: { value: user.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      if (kind === "replaced") await createPasswordReset(user.id, operator);
      const pat = await issue(user);
      await expect(
        completePasswordReset(reset, "synthetic-rejected-password"),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await authenticatePersonalAccessToken(pat.token)).not.toBeNull();
      expect(await revocations(user.id)).toEqual([]);
      expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
      expect((await db.account.findFirstOrThrow({ where: { userId: user.id } })).password).toBe(
        "synthetic-old-hash",
      );
    },
  );

  it("rejects PAT issuance for an inactive or missing persisted owner without write/audit", async () => {
    const user = await owner();
    await db.user.update({ where: { id: user.id }, data: { isActive: false } });
    await expect(issue(user)).rejects.toBeInstanceOf(ValidationError);
    await expect(issue({ ...user, id: "missing-owner" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await db.personalAccessToken.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.activityLog.count({ where: { entityId: user.id } })).toBe(0);
    await expect(createPasswordReset(user.id, operator)).rejects.toBeInstanceOf(ValidationError);
  });

  it("self-admin lockout refusals leave PATs live and unaudited", async () => {
    const user = await owner();
    const admin = await db.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    process.env.REQUIRE_ADMIN_TWO_FACTOR = "false";
    const pat = await issue(admin);
    await expect(
      updateUser(
        admin.id,
        {
          role: "ADMIN",
          initials: admin.initials!,
          isActive: false,
          weeklyCapacityHours: null,
        },
        admin,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(pseudonymizeUser(admin, admin.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await authenticatePersonalAccessToken(pat.token)).not.toBeNull();
    expect(await revocations(user.id)).toEqual([]);
  });
});

describe("PAT lifecycle post-commit realtime effects", () => {
  it.each(boundaries)(
    "%s emits once only after PATs and boundary audit commit",
    async (boundary) => {
      const user = await owner();
      const run = await lifecycle(boundary, user);
      const first = await issue(user);
      const second = await issue(user);
      const emit = vi.spyOn(realtime, "emitChange").mockImplementation(async (event) => {
        expect(event).toEqual({ entityType: "user", id: user.id, op: "updated" });
        const records = await db.personalAccessToken.findMany({
          where: { id: { in: [first.record.id, second.record.id] } },
        });
        expect(records).toHaveLength(2);
        expect(records.every((record) => record.revokedAt !== null)).toBe(true);
        expect(await revocations(user.id)).toHaveLength(2);
        expect(
          await db.activityLog.count({ where: { entityId: user.id, action: auditFor[boundary] } }),
        ).toBe(1);
        expect(await db.session.count({ where: { userId: user.id } })).toBe(
          boundary === "erasure" || boundary === "reset completion" ? 0 : 1,
        );
      });
      const result = await run();
      expect(emit).toHaveBeenCalledExactlyOnceWith({
        entityType: "user",
        id: user.id,
        op: "updated",
      });
      if (boundary === "erasure")
        expect(result).toEqual({ userId: user.id, auditRowsAffected: expect.any(Number) });
      else if (boundary === "reset issuance") expect(result).toMatch(/^[0-9a-f]{64}$/);
      else expect(result).toBeUndefined();
      emit.mockClear();
      if (boundary === "reset completion")
        await expect(run()).rejects.toBeInstanceOf(NotFoundError);
      else await run();
      expect(emit).not.toHaveBeenCalled();
    },
  );

  it.each(boundaries)("%s with no live PATs does not emit", async (boundary) => {
    const user = await owner();
    const run = await lifecycle(boundary, user);
    const alreadyRevoked = await issue(user);
    await revokePersonalAccessToken(user, alreadyRevoked.record.id);
    const emit = vi.spyOn(realtime, "emitChange");
    await run();
    expect(emit).not.toHaveBeenCalled();
  });

  it.each(boundaries)("%s rolled back by its final audit emits nothing", async (boundary) => {
    const user = await owner();
    const run = await lifecycle(boundary, user);
    const pat = await issue(user);
    const emit = vi.spyOn(realtime, "emitChange");
    fault.action = auditFor[boundary];
    await expect(run()).rejects.toThrow("Synthetic audit failure");
    expect(emit).not.toHaveBeenCalled();
    expect((await tokenRow(pat.record.id)).revokedAt).toBeNull();
  });

  it.each(boundaries)("%s rolled back by its PAT audit emits nothing", async (boundary) => {
    const user = await owner();
    const run = await lifecycle(boundary, user);
    const pat = await issue(user);
    const emit = vi.spyOn(realtime, "emitChange");
    fault.action = "PersonalAccessTokenRevoked";
    await expect(run()).rejects.toThrow("Synthetic audit failure");
    expect(emit).not.toHaveBeenCalled();
    expect((await tokenRow(pat.record.id)).revokedAt).toBeNull();
  });

  it("an erasure mutation failure emits nothing", async () => {
    const user = await owner();
    const other = await owner();
    await db.user.update({
      where: { id: other.id },
      data: { email: `erased-${user.id}@erased.local` },
    });
    const pat = await issue(user);
    const emit = vi.spyOn(realtime, "emitChange");
    await expect(pseudonymizeUser(operator, user.id)).rejects.toThrow();
    expect(emit).not.toHaveBeenCalled();
    expect((await tokenRow(pat.record.id)).revokedAt).toBeNull();
  });

  it("an active-user edit does not emit or revoke PATs", async () => {
    const user = await owner();
    const pat = await issue(user);
    const emit = vi.spyOn(realtime, "emitChange");
    await edit(user, true);
    expect(emit).not.toHaveBeenCalled();
    expect((await tokenRow(pat.record.id)).revokedAt).toBeNull();
  });

  it("invalid or expired reset completion does not emit", async () => {
    const user = await owner();
    const reset = await createPasswordReset(user.id, operator);
    await db.verification.updateMany({
      where: { value: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await issue(user);
    const emit = vi.spyOn(realtime, "emitChange");
    await expect(completePasswordReset(reset, "synthetic-expired-password")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      completePasswordReset("invalid", "synthetic-invalid-password"),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(emit).not.toHaveBeenCalled();
  });

  it("deactivation broadcasts committed PAT revocation before a failing session adapter", async () => {
    const user = await owner();
    const pat = await issue(user);
    const { internalAdapter } = await auth.$context;
    const emit = vi.spyOn(realtime, "emitChange").mockImplementation(async (event) => {
      expect(event).toEqual({ entityType: "user", id: user.id, op: "updated" });
      expect((await tokenRow(pat.record.id)).revokedAt).toBeInstanceOf(Date);
      expect(await revocations(user.id)).toHaveLength(1);
      expect(
        await db.activityLog.count({ where: { entityId: user.id, action: "UserUpdated" } }),
      ).toBe(1);
    });
    const adapter = vi
      .spyOn(internalAdapter, "deleteUserSessions")
      .mockImplementation(async (id) => {
        expect(id).toBe(user.id);
        expect(emit).toHaveBeenCalledOnce();
        throw new Error("Synthetic session adapter failure");
      });
    await expect(edit(user, false)).rejects.toThrow("Synthetic session adapter failure");
    expect(adapter).toHaveBeenCalledExactlyOnceWith(user.id);
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      entityType: "user",
      id: user.id,
      op: "updated",
    });
    expect((await tokenRow(pat.record.id)).revokedAt).toBeInstanceOf(Date);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });
});

describe("PAT lifecycle atomic rollback", () => {
  it("PAT creation rolls back its row when its audit fails", async () => {
    const user = await owner();
    fault.action = "PersonalAccessTokenCreated";
    await expect(issue(user)).rejects.toThrow("Synthetic audit failure");
    fault.action = "";
    expect(await db.personalAccessToken.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.activityLog.count({ where: { entityId: user.id } })).toBe(0);
  });

  it("a real deactivation uniqueness failure leaves the PAT, reset link and sessions intact", async () => {
    const user = await owner();
    const other = await owner();
    const reset = await createPasswordReset(user.id, operator);
    const pat = await issue(user);
    await expect(
      updateUser(
        user.id,
        { role: "MEMBER", initials: other.initials!, isActive: false, weeklyCapacityHours: null },
        operator,
      ),
    ).rejects.toThrow();
    expect((await tokenRow(pat.record.id)).revokedAt).toBeNull();
    expect(await revocations(user.id)).toEqual([]);
    expect(await resolvePasswordReset(reset)).toMatchObject({ userId: user.id });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).isActive).toBe(true);
  });

  it.each(boundaries)(
    "%s rolls back PAT revocation, audit and lifecycle writes after final audit failure",
    async (boundary) => {
      const user = await owner();
      const run = await lifecycle(boundary, user);
      const pat = await issue(user);
      const beforeUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      const beforeAccount = await db.account.findMany({ where: { userId: user.id } });
      const beforeLinks = await db.verification.findMany({ where: { value: user.id } });
      const auditsBefore = await db.activityLog.count({ where: { entityId: user.id } });
      fault.action = auditFor[boundary];
      await expect(run()).rejects.toThrow("Synthetic audit failure");
      fault.action = "";
      expect((await tokenRow(pat.record.id)).revokedAt).toBeNull();
      expect(await revocations(user.id)).toEqual([]);
      expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toEqual(beforeUser);
      expect(await db.account.findMany({ where: { userId: user.id } })).toEqual(beforeAccount);
      expect(await db.verification.findMany({ where: { value: user.id } })).toEqual(beforeLinks);
      expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
      expect(await db.activityLog.count({ where: { entityId: user.id } })).toBe(auditsBefore);
      await run();
      expect((await tokenRow(pat.record.id)).revokedAt).toBeInstanceOf(Date);
    },
  );

  it.each(boundaries)("%s rolls back if the PAT revocation audit fails", async (boundary) => {
    const user = await owner();
    const run = await lifecycle(boundary, user);
    const pat = await issue(user);
    fault.action = "PersonalAccessTokenRevoked";
    await expect(run()).rejects.toThrow("Synthetic audit failure");
    fault.action = "";
    expect((await tokenRow(pat.record.id)).revokedAt).toBeNull();
    expect(await revocations(user.id)).toEqual([]);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).isActive).toBe(true);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    await run();
    expect((await tokenRow(pat.record.id)).revokedAt).toBeInstanceOf(Date);
  });

  it("a real erasure uniqueness failure rolls back credential deletion, PATs and prior revocation audit", async () => {
    const user = await owner();
    const collision = await owner();
    await db.user.update({
      where: { id: collision.id },
      data: { email: `erased-${user.id}@erased.local` },
    });
    const pat = await issue(user);
    await expect(pseudonymizeUser(operator, user.id)).rejects.toThrow();
    expect((await tokenRow(pat.record.id)).revokedAt).toBeNull();
    expect(await revocations(user.id)).toEqual([]);
    expect(await db.account.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
    expect(await db.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      email: user.email,
      isActive: true,
    });
  });
});

async function blockRow(lock: (tx: Tx) => Promise<unknown>) {
  let ready!: (pid: number) => void;
  let release!: () => void;
  const acquired = new Promise<number>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const operation = txWithAudit(null, async (tx) => {
    await lock(tx);
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    ready(row.pid);
    await gate;
  });
  const pid = await acquired;
  return {
    async waitForBlocked(count: number) {
      await expect
        .poll(
          async () => {
            const [row] = await db.$queryRaw<Array<{ count: bigint }>>`
          WITH RECURSIVE blocked AS (
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))
            UNION
            SELECT activity.pid FROM pg_stat_activity activity
            JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
            WHERE activity.datname = current_database()
          )
          SELECT count(*) FROM blocked
        `;
            return Number(row.count);
          },
          { timeout: 10_000 },
        )
        .toBeGreaterThanOrEqual(count);
    },
    async release() {
      release();
      await operation;
    },
  };
}

describe("PAT lifecycle serialization", () => {
  it.each(boundaries)(
    "issuance ordered before %s is revoked in that boundary",
    async (boundary) => {
      const user = await owner();
      const run = await lifecycle(boundary, user);
      const blocker = await blockRow(
        (tx) => tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`,
      );
      const creation = issue(user);
      const results: Promise<unknown>[] = [creation];
      try {
        await blocker.waitForBlocked(1);
        results.push(run());
        await blocker.waitForBlocked(2);
      } finally {
        await blocker.release();
        await Promise.allSettled(results);
      }
      const pat = await creation;
      await results[1];
      expect((await tokenRow(pat.record.id)).revokedAt).toBeInstanceOf(Date);
      expect(await authenticatePersonalAccessToken(pat.token)).toBeNull();
      expect(await revocations(user.id)).toHaveLength(1);
    },
  );

  it.each(boundaries)(
    "issuance ordered after %s re-reads the committed owner state",
    async (boundary) => {
      const user = await owner();
      const run = await lifecycle(boundary, user);
      const blocker = await blockRow(
        (tx) => tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`,
      );
      const mutation = run();
      const results: Promise<unknown>[] = [mutation];
      let creation!: ReturnType<typeof issue>;
      try {
        await blocker.waitForBlocked(1);
        creation = issue(user);
        results.push(creation);
        await blocker.waitForBlocked(2);
      } finally {
        await blocker.release();
        await Promise.allSettled(results);
      }
      await mutation;
      if (boundary === "deactivation" || boundary === "erasure") {
        await expect(creation).rejects.toBeInstanceOf(ValidationError);
        expect(await db.personalAccessToken.count({ where: { userId: user.id } })).toBe(0);
      } else {
        const pat = await creation;
        expect(await authenticatePersonalAccessToken(pat.token)).not.toBeNull();
        expect(await revocations(user.id)).toEqual([]);
      }
    },
  );

  it.each(boundaries)(
    "authentication queued after %s revocation loses the conditional update",
    async (boundary) => {
      const user = await owner();
      const run = await lifecycle(boundary, user);
      const pat = await issue(user);
      const blocker = await blockRow(
        (tx) =>
          tx.$queryRaw`SELECT id FROM "PersonalAccessToken" WHERE id = ${pat.record.id} FOR UPDATE`,
      );
      const mutation = run();
      const results: Promise<unknown>[] = [mutation];
      let authentication!: ReturnType<typeof authenticatePersonalAccessToken>;
      try {
        await blocker.waitForBlocked(1);
        authentication = authenticatePersonalAccessToken(pat.token);
        results.push(authentication);
        await blocker.waitForBlocked(2);
      } finally {
        await blocker.release();
        await Promise.allSettled(results);
      }
      await mutation;
      expect(await authentication).toBeNull();
      expect((await tokenRow(pat.record.id)).lastUsedAt).toBeNull();
      expect(await revocations(user.id)).toHaveLength(1);
    },
  );

  it.each(boundaries)(
    "competing %s calls audit each PAT revocation only once",
    async (boundary) => {
      const user = await owner();
      const run = await lifecycle(boundary, user);
      const pat = await issue(user);
      const blocker = await blockRow(
        (tx) => tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`,
      );
      const results = Promise.allSettled([run(), run()]);
      try {
        await blocker.waitForBlocked(2);
      } finally {
        await blocker.release();
      }
      const settled = await results;
      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(
        boundary === "reset completion" ? 1 : 2,
      );
      if (boundary === "reset completion") {
        expect(settled.find((result) => result.status === "rejected")).toMatchObject({
          reason: expect.any(NotFoundError),
        });
      }
      expect((await tokenRow(pat.record.id)).revokedAt).toBeInstanceOf(Date);
      expect(await revocations(user.id)).toHaveLength(1);
    },
  );

  it.each(["manual first", "lifecycle first"])(
    "manual and lifecycle revocation audit only the winner: %s",
    async (order) => {
      const user = await owner();
      const pat = await issue(user);
      const blocker = await blockRow(
        (tx) =>
          tx.$queryRaw`SELECT id FROM "PersonalAccessToken" WHERE id = ${pat.record.id} FOR UPDATE`,
      );
      const manual = () => revokePersonalAccessToken(user, pat.record.id);
      const deactivate = () => edit(user, false);
      const first = order === "manual first" ? manual() : deactivate();
      const results: Promise<unknown>[] = [first];
      try {
        await blocker.waitForBlocked(1);
        results.push(order === "manual first" ? deactivate() : manual());
        await blocker.waitForBlocked(2);
      } finally {
        await blocker.release();
        await Promise.allSettled(results);
      }
      await Promise.all(results);
      const logs = await revocations(user.id);
      expect(logs).toHaveLength(1);
      expect(logs[0].data).toEqual(
        order === "manual first"
          ? { tokenId: pat.record.id, name: pat.record.name, scope: pat.record.scope }
          : { tokenId: pat.record.id, scope: pat.record.scope, reason: "USER_DEACTIVATED" },
      );
    },
  );

  it.each(["deactivation", "erasure"] as const)(
    "completion queued behind %s cannot restore credentials or use its reset link",
    async (boundary) => {
      const user = await owner();
      const reset = await createPasswordReset(user.id, operator);
      const pat = await issue(user);
      const run = await lifecycle(boundary, user);
      const blocker = await blockRow(
        (tx) => tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`,
      );
      const mutation = run();
      let completion!: ReturnType<typeof completePasswordReset>;
      const results: Promise<unknown>[] = [mutation];
      try {
        await blocker.waitForBlocked(1);
        completion = completePasswordReset(reset, "synthetic-losing-password");
        results.push(completion);
        await blocker.waitForBlocked(2);
      } finally {
        await blocker.release();
        await Promise.allSettled(results);
      }
      await mutation;
      await expect(completion).rejects.toBeInstanceOf(NotFoundError);
      expect((await tokenRow(pat.record.id)).revokedAt).toBeInstanceOf(Date);
      expect(await db.account.findMany({ where: { userId: user.id } })).toEqual(
        boundary === "erasure" ? [] : [expect.objectContaining({ password: "synthetic-old-hash" })],
      );
      expect(
        await db.activityLog.count({ where: { entityId: user.id, action: "PasswordReset" } }),
      ).toBe(0);
    },
  );

  it("completion rechecks expiry after waiting for the owner lock", async () => {
    const user = await owner();
    const reset = await createPasswordReset(user.id, operator);
    const pat = await issue(user);
    const blocker = await blockRow(
      (tx) => tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`,
    );
    const completion = completePasswordReset(reset, "synthetic-expired-password");
    try {
      await blocker.waitForBlocked(1);
      await db.verification.updateMany({
        where: { value: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    } finally {
      await blocker.release();
      await Promise.allSettled([completion]);
    }
    await expect(completion).rejects.toBeInstanceOf(NotFoundError);
    expect((await tokenRow(pat.record.id)).revokedAt).toBeNull();
    expect(await revocations(user.id)).toEqual([]);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(1);
  });

  it("an authentication admitted before revocation stays admitted, but later authentication fails", async () => {
    const user = await owner();
    const pat = await issue(user);
    const admitted = await authenticatePersonalAccessToken(pat.token);
    expect(admitted).not.toBeNull();
    await edit(user, false);
    expect(admitted?.user.id).toBe(user.id);
    expect(await authenticatePersonalAccessToken(pat.token)).toBeNull();
    expect((await tokenRow(pat.record.id)).lastUsedAt).toBeInstanceOf(Date);
  });
});
