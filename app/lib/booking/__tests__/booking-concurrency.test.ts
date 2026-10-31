import { afterAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

/**
 * Concurrency guard. The
 * no-double-booking EXCLUDE constraint is only load-bearing if it holds under a
 * genuine race: two SEPARATE connections in overlapping transactions inserting
 * conflicting bookings for the same room. The GiST EXCLUDE is checked at INSERT
 * time, so the second INSERT BLOCKS on the first transaction until it resolves —
 * then either commits (if the first rolled back) or fails SQLSTATE 23P01 (if the
 * first committed). The both-committed outcome (a real double-booking) must never
 * happen.
 *
 * This complements booking-constraints.test.ts (single-connection rejection) —
 * that test cannot observe the cross-transaction blocking this one asserts.
 *
 * All rows created here are prefixed with RUN and deleted in afterAll (never
 * TRUNCATE; no ActivityLog rows are touched).
 */

const RUN = `t_conc_${Date.now()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });

const ids = {
  campus: `${RUN}_campus`,
  room: `${RUN}_room`,
  event: `${RUN}_event`,
};

afterAll(async () => {
  // FK order: bookings → event/room → campus. Only our RUN-prefixed rows.
  await pool.query(`DELETE FROM "EventRoomBooking" WHERE "eventId" = $1`, [ids.event]);
  await pool.query(`DELETE FROM "Event" WHERE id = $1`, [ids.event]);
  await pool.query(`DELETE FROM "Room" WHERE id = $1`, [ids.room]);
  await pool.query(`DELETE FROM "Campus" WHERE id = $1`, [ids.campus]);
  await pool.end();
});

async function seed() {
  await pool.query(
    `INSERT INTO "Campus"(id,name,slug,"createdAt","updatedAt") VALUES($1,$1,$1,now(),now())`,
    [ids.campus],
  );
  await pool.query(
    `INSERT INTO "Room"(id,slug,name,status,"hasProjector","hasMicrophony","hasBlackboard","hasWebConference","hasAutoRecording","mediaKeyRequired","createdAt","updatedAt")
     VALUES($1,$1,'R','ALL_GOOD',false,false,false,false,false,false,now(),now())`,
    [ids.room],
  );
  await pool.query(
    `INSERT INTO "Event"(id,uid,title,"startsAt","endsAt",status,"createdAt","updatedAt")
     VALUES($1,$1,'E','2026-07-01T08:00:00+02','2026-07-01T20:00:00+02','PLANNED',now(),now())`,
    [ids.event],
  );
}

function insertBooking(c: PoolClient, id: string, start: string, end: string) {
  return c.query(
    `INSERT INTO "EventRoomBooking"(id,"eventId","roomId","startsAt","endsAt",cancelled,"createdAt")
     VALUES($1,$2,$3,$4,$5,false,now())`,
    [id, ids.event, ids.room, start, end],
  );
}

describe("no-double-booking under concurrency (two connections)", () => {
  it("lets exactly one of two overlapping room bookings commit; the other gets 23P01", async () => {
    await seed();

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");

      // A inserts first — no conflicting row is visible yet, so it succeeds and
      // now holds the range. B's overlapping insert (fired next) BLOCKS on A.
      await insertBooking(a, `${RUN}_erb_a`, "2026-07-01T10:00:00+02", "2026-07-01T12:00:00+02");

      // Fire B's insert WITHOUT awaiting — it parks inside Postgres waiting for A.
      // Settle the rejection into a VALUE at creation time, not at assertion time:
      // B rejects the instant A commits below, and that happens *during* the
      // COMMIT await. A handler attached after that await is too late — Node reports
      // an unhandled rejection and fails the whole run (exit 1) even though every
      // assertion here passes. Identical to schema-hardening.test.ts:121-131.
      const bOutcome = insertBooking(
        b,
        `${RUN}_erb_b`,
        "2026-07-01T11:00:00+02",
        "2026-07-01T13:00:00+02",
      ).then(
        () => null,
        (err) => err,
      );

      // Let B actually reach the lock wait, so the race below is a real blocked
      // INSERT and not two sequential statements that merely look concurrent.
      await new Promise((r) => setTimeout(r, 100));

      // Now commit A. That releases B's insert, which then sees the committed row
      // and fails the exclusion constraint with 23P01.
      await a.query("COMMIT");

      // null would mean B committed — i.e. a real double-booking — and fails the match.
      expect(await bOutcome).toMatchObject({ code: "23P01" });

      // B's tx is now aborted; roll it back explicitly.
      await b.query("ROLLBACK").catch(() => {});
    } finally {
      a.release();
      b.release();
    }

    // Ground truth: exactly one uncancelled booking survived in the DB.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "EventRoomBooking"
       WHERE "roomId" = $1 AND cancelled = false`,
      [ids.room],
    );
    expect(rows[0].n).toBe("1");
  });
});
