import { afterAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

/**
 * Database hardening guards, plus a concurrent-booking race. These assert the
 * shipped constraints hold:
 *   - CalendarOutbox is unique on (eventUid, sequence) — DB-enforced idempotency,
 *   - Room renewal windows can't be inverted (CHECK), and
 *   - the booking EXCLUDE serializes two *concurrent* transactions, not just two
 *     inserts in one tx (the un-droppable no-double-booking invariant under races).
 */

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

let seq = 0;
const uid = (p: string) => `test_${p}_${Date.now()}_${seq++}`;

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

const insertOutbox = (c: PoolClient, id: string, eventUid: string, sequence: number) =>
  c.query(
    `INSERT INTO "CalendarOutbox"(id,op,"eventUid",sequence,payload)
     VALUES($1,'UPSERT',$2,$3,'{}'::jsonb)`,
    [id, eventUid, sequence],
  );

describe("CalendarOutbox idempotency", () => {
  it("rejects a duplicate (eventUid, sequence) with 23505", async () => {
    await inRolledBackTx(async (c) => {
      const ev = uid("evt");
      await insertOutbox(c, uid("ob"), ev, 0);
      await expect(insertOutbox(c, uid("ob"), ev, 0)).rejects.toMatchObject({ code: "23505" });
    });
  });

  it("allows the same event at a different sequence", async () => {
    await inRolledBackTx(async (c) => {
      const ev = uid("evt");
      await insertOutbox(c, uid("ob"), ev, 0);
      await expect(insertOutbox(c, uid("ob"), ev, 1)).resolves.toBeDefined();
    });
  });
});

describe("Room renewal-order CHECK", () => {
  const insertRoom = (c: PoolClient, id: string, from: string | null, to: string | null) =>
    c.query(
      `INSERT INTO "Room"(id,slug,name,status,"hasProjector","hasMicrophony","hasBlackboard",
         "hasWebConference","hasAutoRecording","mediaKeyRequired","createdAt","updatedAt","renewalFrom","renewalTo")
       VALUES($1,$1,'R','ALL_GOOD',false,false,false,false,false,false,now(),now(),$2,$3)`,
      [id, from, to],
    );

  it("rejects an inverted renewal window with 23514", async () => {
    await inRolledBackTx(async (c) => {
      await expect(
        insertRoom(c, uid("room"), "2026-12-01T00:00:00+01", "2026-01-01T00:00:00+01"),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("allows an ordered window and any NULL bound", async () => {
    await inRolledBackTx(async (c) => {
      await expect(
        insertRoom(c, uid("room"), "2026-01-01T00:00:00+01", "2026-12-01T00:00:00+01"),
      ).resolves.toBeDefined();
      await expect(
        insertRoom(c, uid("room"), null, "2026-12-01T00:00:00+01"),
      ).resolves.toBeDefined();
      await expect(
        insertRoom(c, uid("room"), "2026-01-01T00:00:00+01", null),
      ).resolves.toBeDefined();
      await expect(insertRoom(c, uid("room"), null, null)).resolves.toBeDefined();
    });
  });
});

describe("no-double-booking under concurrency", () => {
  const insertBooking = (
    c: PoolClient,
    id: string,
    ev: string,
    room: string,
    s: string,
    e: string,
  ) =>
    c.query(
      `INSERT INTO "EventRoomBooking"(id,"eventId","roomId","startsAt","endsAt",cancelled,"createdAt")
       VALUES($1,$2,$3,$4,$5,false,now())`,
      [id, ev, room, s, e],
    );

  it("serializes two concurrent overlapping bookings — exactly one wins (23P01)", async () => {
    const ids = { campus: uid("campus"), room: uid("room"), event: uid("event") };
    // Committed seed (the race needs cross-transaction visibility, so no rollback tx).
    await pool.query(
      `INSERT INTO "Campus"(id,name,slug,"createdAt","updatedAt") VALUES($1,$1,$1,now(),now())`,
      [ids.campus],
    );
    await pool.query(
      `INSERT INTO "Room"(id,slug,name,status,"hasProjector","hasMicrophony","hasBlackboard",
         "hasWebConference","hasAutoRecording","mediaKeyRequired","createdAt","updatedAt")
       VALUES($1,$1,'R','ALL_GOOD',false,false,false,false,false,false,now(),now())`,
      [ids.room],
    );
    await pool.query(
      `INSERT INTO "Event"(id,uid,title,"startsAt","endsAt",status,"createdAt","updatedAt")
       VALUES($1,$1,'E',$2,$3,'PLANNED',now(),now())`,
      [ids.event, "2026-07-01T08:00:00+02", "2026-07-01T20:00:00+02"],
    );

    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      await insertBooking(
        a,
        uid("erb"),
        ids.event,
        ids.room,
        "2026-07-01T10:00:00+02",
        "2026-07-01T12:00:00+02",
      );
      // B's overlapping insert blocks on A's pending row (GiST exclusion predicate lock).
      // Capture B's outcome eagerly (settle rejection into a value): B rejects the instant
      // A commits below, and that happens *during* the COMMIT await — if no handler is
      // attached at that moment Node reports an unhandled rejection and fails the run even
      // though the assertion passes. Settling here attaches the handler before B unblocks.
      const bOutcome = insertBooking(
        b,
        uid("erb"),
        ids.event,
        ids.room,
        "2026-07-01T11:00:00+02",
        "2026-07-01T13:00:00+02",
      ).then(
        () => null,
        (err) => err,
      );
      await new Promise((r) => setTimeout(r, 100)); // let B reach the lock wait
      await a.query("COMMIT"); // A wins; B now conflicts with a committed row
      expect(await bOutcome).toMatchObject({ code: "23P01" }); // null (B won) fails the match
      await b.query("ROLLBACK").catch(() => {});
    } finally {
      a.release();
      b.release();
      // EventRoomBooking -> Event is onDelete: Restrict, so delete the booking(s)
      // before the event; then room, campus.
      await pool.query(`DELETE FROM "EventRoomBooking" WHERE "eventId"=$1`, [ids.event]);
      await pool.query(`DELETE FROM "Event" WHERE id=$1`, [ids.event]);
      await pool.query(`DELETE FROM "Room" WHERE id=$1`, [ids.room]);
      await pool.query(`DELETE FROM "Campus" WHERE id=$1`, [ids.campus]);
    }
  });
});
