import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { db } from "~/lib/db.server";
import { pseudonymizeUser, pruneActivityLog } from "~/domains/auth/gdpr.server";

/**
 * GDPR pseudonymization + retention. Verifies the privileged functions
 * actually bypass the ActivityLog immutability guard and produce the required
 * result: audit snapshots reduced to initials-only, ticket links severed, the
 * user row scrubbed + deactivated. Also asserts direct app-role UPDATE/DELETE on
 * ActivityLog is STILL rejected (the guard stays bulletproof).
 */

const createdUserIds: string[] = [];
const createdTicketIds: string[] = [];
const createdActivityIds: string[] = [];
// A separate row seeded far in the past so the sanctioned prune actually deletes.
let prunableActivityId = "";

// Raw pg pool (mirrors booking-constraints.test.ts) for the replica-bypass test:
// Prisma's driver adapter would swallow the SET, so exercise it on a real client.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/** Run fn in a transaction that is ALWAYS rolled back (per-test isolation). */
async function inRolledBackTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

beforeAll(async () => {
  // A user with a couple of audit rows carrying name/email in the snapshot.
  const user = await db.user.create({
    data: {
      name: "Erase Me",
      email: `erase_${Date.now()}@jiangtang.local`,
      initials: "EM",
      role: "MEMBER",
    },
  });
  createdUserIds.push(user.id);

  for (const action of ["TicketResolved", "RoomUpdated"]) {
    const a = await db.activityLog.create({
      data: {
        action,
        entityType: "ticket",
        entityId: "x",
        actorId: user.id,
        actorSnapshot: { name: "Erase Me", email: user.email, initials: "EM" },
        occurredAt: new Date(),
      },
    });
    createdActivityIds.push(a.id);
  }

  // A ticket reported by the user (the link should be severed on erasure).
  const ticket = await db.ticket.create({
    data: { type: "INCIDENT", status: "OPEN", title: "t", reporterId: user.id },
  });
  createdTicketIds.push(ticket.id);

  // A far-past audit row (year 2000) so the sanctioned prune has something to
  // delete without touching real data. NOT tracked in createdActivityIds — the
  // prune test deletes it via the privileged function.
  const old = await db.activityLog.create({
    data: {
      action: "AncientAction",
      entityType: "ticket",
      entityId: "x",
      occurredAt: new Date("2000-01-01T00:00:00Z"),
    },
  });
  prunableActivityId = old.id;
});

afterAll(async () => {
  for (const id of createdTicketIds)
    await db.ticket.delete({ where: { id } }).catch(() => undefined);
  // These rows may have been pseudonymized (still un-deletable directly via
  // the trigger) — the only sanctioned DELETE path is the privileged prune
  // function. A blanket `prune_activity_log(NOW()+1 day)` would nuke every real
  // row in a shared DB, so instead pseudonymize-then-backdate JUST the rows this
  // test created (by id), then prune with a cutoff that only reaches those
  // backdated rows (plus the already-far-past prunable row from the test body).
  if (createdActivityIds.length > 0) {
    await db.activityLog
      .updateMany({
        where: { id: { in: createdActivityIds } },
        data: { occurredAt: new Date("2000-01-01T00:00:00Z") },
      })
      .catch(() => undefined);
  }
  await db.$executeRaw`SELECT prune_activity_log('2001-01-01T00:00:00Z'::timestamptz)`.catch(
    () => undefined,
  );
  for (const id of createdUserIds) await db.user.delete({ where: { id } }).catch(() => undefined);
  await pool.end().catch(() => undefined);
  await db.$disconnect();
});

describe("GDPR pseudonymization", () => {
  it("reduces the actor snapshot to initials-only across the audit log", async () => {
    const userId = createdUserIds[0];
    const result = await pseudonymizeUser(
      { id: "test-admin", name: "Admin", email: "a@a", initials: "AD" },
      userId,
    );
    expect(result.auditRowsAffected).toBeGreaterThanOrEqual(2);

    const rows = await db.activityLog.findMany({ where: { actorId: userId } });
    for (const r of rows) {
      const snap = r.actorSnapshot as { name?: string; email?: string; initials?: string } | null;
      // initials survive; name/email are gone.
      expect(snap?.name).toBeUndefined();
      expect(snap?.email).toBeUndefined();
      expect(snap?.initials).toBe("EM");
    }
  });

  it("scrubs and deactivates the user row", async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: createdUserIds[0] } });
    expect(user.isActive).toBe(false);
    expect(user.name).toBe("[pseudonymisiert]");
    expect(user.email).toContain("erased-");
    expect(user.email).toContain("@erased.local");
    expect(user.initials).toBeNull();
  });

  it("severs the user's ticket reporter link", async () => {
    const ticket = await db.ticket.findUniqueOrThrow({ where: { id: createdTicketIds[0] } });
    expect(ticket.reporterId).toBeNull();
  });

  it("leaves the user's time entries in place (labour records survive)", async () => {
    // A fresh user so this test stands alone — user[0] is already erased above.
    const u = await db.user.create({
      data: {
        name: "Erase Me Too",
        email: `erase2_${Date.now()}@jiangtang.local`,
        initials: "ET",
        role: "MEMBER",
      },
    });
    createdUserIds.push(u.id);
    const entry = await db.timeEntry.create({
      data: {
        userId: u.id,
        startsAt: new Date("2026-10-06T08:00:00Z"),
        endsAt: new Date("2026-10-06T10:00:00Z"),
      },
    });
    try {
      await pseudonymizeUser(
        { id: "test-admin", name: "Admin", email: "a@a", initials: "AD" },
        u.id,
      );
      // The row survives, still attributed to the (now pseudonymized) user —
      // Restrict + NOT NULL is the contract; the erasure path must not sever it.
      const kept = await db.timeEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(kept.userId).toBe(u.id);
      expect(kept.endsAt).not.toBeNull();
    } finally {
      await db.timeEntry.delete({ where: { id: entry.id } }).catch(() => undefined);
    }
  });

  it("still REJECTS direct app-role UPDATE/DELETE on ActivityLog (guard intact)", async () => {
    // The trigger raises 'restrict_violation' (23001) for any direct write.
    await expect(
      db.$executeRaw`UPDATE "ActivityLog" SET "action" = 'tampered' WHERE "id" = ${createdActivityIds[0]}`,
    ).rejects.toThrow();

    await expect(
      db.$executeRaw`DELETE FROM "ActivityLog" WHERE "id" = ${createdActivityIds[0]}`,
    ).rejects.toThrow();
  });
});

describe("attachment erasure (Attachment.createdById)", () => {
  it("severs the attachment creator link but keeps the row and its objectKey", async () => {
    // A fresh user so this test stands alone (mirrors the time-entry test above).
    const u = await db.user.create({
      data: {
        name: "Erase Me Three",
        email: `erase3_${Date.now()}@jiangtang.local`,
        initials: "E3",
        role: "MEMBER",
      },
    });
    createdUserIds.push(u.id);
    const objectKey = `erasure-test/${u.id}-${Date.now()}`;
    const attachment = await db.attachment.create({
      data: {
        objectKey,
        category: "ROOM",
        filename: "ground-floor.png",
        contentType: "image/png",
        createdById: u.id,
      },
    });
    try {
      // Before erasure the personal link exists — otherwise the test proves nothing.
      const before = await db.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
      expect(before.createdById).toBe(u.id);

      await pseudonymizeUser(
        { id: "test-admin", name: "Admin", email: "a@a", initials: "AD" },
        u.id,
      );

      // createdById must be NULL — erased, not merely unreachable.
      const after = await db.attachment.findUniqueOrThrow({ where: { id: attachment.id } });
      expect(after.createdById).toBeNull();
      // The operational record survives: only the personal link is severed, the
      // attachment row and its storage objectKey stay (no blob deletion here).
      expect(after.objectKey).toBe(objectKey);
    } finally {
      await db.attachment.delete({ where: { id: attachment.id } }).catch(() => undefined);
    }
  });

  it("pins the DB contract: Attachment_createdById_fkey exists with ON DELETE SET NULL", async () => {
    // Schema-contract guard on the MIGRATED database: the FK must exist in
    // pg_constraint (not only in schema.prisma), be a foreign key ('f'),
    // delete-rule SET NULL ('n'), reference "User", and leave createdById nullable.
    const { rows } = await pool.query(`
      SELECT c.contype, c.confdeltype, ft.relname AS foreign_table, a.attnotnull
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_class ft ON ft.oid = c.confrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'createdById'
      WHERE n.nspname = current_schema()
        AND t.relname = 'Attachment'
        AND c.conname = 'Attachment_createdById_fkey'
    `);
    // A missing constraint yields zero rows — that is the regression this pins.
    expect(rows).toHaveLength(1);
    expect(rows[0].contype).toBe("f");
    expect(rows[0].confdeltype).toBe("n");
    expect(rows[0].foreign_table).toBe("User");
    expect(rows[0].attnotnull).toBe(false);
  });
});

describe("session_replication_role='replica' cannot bypass the guard", () => {
  // A default-enabled trigger is skipped under
  // session_replication_role='replica'. The trigger is ENABLE ALWAYS, so even
  // a superuser flipping that knob is still blocked — only the transaction-local
  // `jiangtang.audit_bypass` flag (set solely by the privileged functions) lets a
  // write through. The app DB role is superuser locally; that is the point.
  it("rejects DELETE under replica role with SQLSTATE 23001", async () => {
    await inRolledBackTx(async (c) => {
      await c.query("SET LOCAL session_replication_role = 'replica'");
      await expect(
        c.query(`DELETE FROM "ActivityLog" WHERE "id" = $1`, [prunableActivityId]),
      ).rejects.toMatchObject({ code: "23001" });
    });
  });

  it("rejects UPDATE under replica role with SQLSTATE 23001", async () => {
    await inRolledBackTx(async (c) => {
      await c.query("SET LOCAL session_replication_role = 'replica'");
      await expect(
        c.query(`UPDATE "ActivityLog" SET "action" = 'tampered' WHERE "id" = $1`, [
          prunableActivityId,
        ]),
      ).rejects.toMatchObject({ code: "23001" });
    });
  });
});

describe("session revocation on erasure", () => {
  it("deletes the erased user's sessions and leaves other users' sessions alone", async () => {
    const stamp = Date.now();
    const target = await db.user.create({
      data: {
        name: "Erase Session",
        email: `erase_sess_${stamp}@jiangtang.local`,
        initials: "ES",
        role: "MEMBER",
      },
    });
    createdUserIds.push(target.id);
    const bystander = await db.user.create({
      data: {
        name: "Erase Bystander",
        email: `erase_by_${stamp}@jiangtang.local`,
        initials: "EB",
        role: "MEMBER",
      },
    });
    createdUserIds.push(bystander.id);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.session.create({
      data: { token: `erase_${stamp}_target`, userId: target.id, expiresAt },
    });
    await db.session.create({
      data: { token: `erase_${stamp}_bystander`, userId: bystander.id, expiresAt },
    });
    expect(await db.session.count({ where: { userId: target.id } })).toBe(1);

    await pseudonymizeUser(
      { id: "test-admin", name: "Admin", email: "a@a", initials: "AD" },
      target.id,
    );

    expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
    expect(await db.session.count({ where: { userId: bystander.id } })).toBe(1);
  });
});

describe("credential and invitation erasure", () => {
  it("deletes the erased user's accounts, sessions and pending invitations in the erasure", async () => {
    const stamp = Date.now();
    const email = `erase_cred_${stamp}@jiangtang.local`;
    const target = await db.user.create({
      data: { name: "Erase Credential", email, initials: "EC", role: "MEMBER" },
    });
    createdUserIds.push(target.id);
    const bystander = await db.user.create({
      data: {
        name: "Credential Bystander",
        email: `erase_cred_by_${stamp}@jiangtang.local`,
        initials: "CB",
        role: "MEMBER",
      },
    });
    createdUserIds.push(bystander.id);
    for (const u of [target, bystander]) {
      await db.account.create({
        data: {
          accountId: u.id,
          providerId: "credential",
          userId: u.id,
          password: "synthetic-hash",
        },
      });
    }
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.session.create({
      data: { token: `erase_cred_${stamp}_target`, userId: target.id, expiresAt },
    });
    const invite = await db.verification.create({
      data: { identifier: email, value: JSON.stringify({ token: `t${stamp}`, email }), expiresAt },
    });
    const resetLink = await db.verification.create({
      data: { identifier: `password-reset:synthetic-${stamp}`, value: target.id, expiresAt },
    });
    const otherInvite = await db.verification.create({
      data: {
        identifier: `erase_cred_other_${stamp}@jiangtang.local`,
        value: JSON.stringify({ token: `o${stamp}` }),
        expiresAt,
      },
    });

    try {
      await pseudonymizeUser(
        { id: "test-admin", name: "Admin", email: "a@a", initials: "AD" },
        target.id,
      );

      expect(await db.account.count({ where: { userId: target.id } })).toBe(0);
      expect(await db.session.count({ where: { userId: target.id } })).toBe(0);
      expect(await db.verification.findUnique({ where: { id: invite.id } })).toBeNull();
      expect(await db.verification.findUnique({ where: { id: resetLink.id } })).toBeNull();
      // Other people's credentials and invitations are untouched.
      expect(await db.account.count({ where: { userId: bystander.id } })).toBe(1);
      expect(await db.verification.findUnique({ where: { id: otherInvite.id } })).not.toBeNull();
    } finally {
      await db.account.deleteMany({ where: { userId: bystander.id } });
      await db.verification.deleteMany({
        where: { id: { in: [invite.id, resetLink.id, otherInvite.id] } },
      });
    }
  });

  it("keeps the credential when the erasure is refused", async () => {
    const stamp = Date.now();
    const u = await db.user.create({
      data: {
        name: "Self Eraser",
        email: `erase_self_${stamp}@jiangtang.local`,
        initials: "SE",
        role: "ADMIN",
      },
    });
    createdUserIds.push(u.id);
    await db.account.create({
      data: { accountId: u.id, providerId: "credential", userId: u.id, password: "synthetic-hash" },
    });
    try {
      await expect(
        pseudonymizeUser({ id: u.id, name: "Self", email: u.email, initials: "SE" }, u.id),
      ).rejects.toThrow();
      expect(await db.account.count({ where: { userId: u.id } })).toBe(1);
    } finally {
      await db.account.deleteMany({ where: { userId: u.id } });
    }
  });
});

describe("retention prune (privileged DELETE — sanctioned path still works)", () => {
  it("prune_activity_log deletes nothing for a pre-history cutoff", async () => {
    // A far-past cutoff matches no rows — safe, deletes nothing real.
    const deleted = await pruneActivityLog(new Date("1900-01-01"));
    expect(deleted).toBe(0); // nothing is older than 1900
  });

  it("prune_activity_log deletes the seeded year-2000 row via the audit_bypass gate", async () => {
    // The privileged SECURITY DEFINER function sets jiangtang.audit_bypass='on', so
    // the ENABLE ALWAYS trigger lets its DELETE through even though a raw DELETE
    // (see the replica-role tests above) is rejected. Cutoff after 2000 but
    // before the test's present-day rows, so only the seeded ancient row is removed.
    const deleted = await pruneActivityLog(new Date("2001-01-01"));
    expect(deleted).toBeGreaterThanOrEqual(1);

    const gone = await db.activityLog.findUnique({ where: { id: prunableActivityId } });
    expect(gone).toBeNull();
  });
});
