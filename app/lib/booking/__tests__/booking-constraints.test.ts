import { afterAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

/**
 * CI GUARD (golden rules). These tests fail the build if the
 * load-bearing DB invariants are ever weakened:
 *   1. no-double-booking EXCLUDE constraints exist and reject overlaps (23P01),
 *      honour half-open [) ranges, and exempt cancelled rows, and
 *   2. ActivityLog is append-only (UPDATE/DELETE rejected).
 * Never delete or weaken these.
 */

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

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

let seq = 0;
const uid = (p: string) => `test_${p}_${Date.now()}_${seq++}`;

const T = {
  // A 12h event window; bookings live inside it.
  eventStart: "2026-07-01T08:00:00+02",
  eventEnd: "2026-07-01T20:00:00+02",
};

async function seed(c: PoolClient) {
  const ids = {
    campus: uid("campus"),
    room: uid("room"),
    model: uid("model"),
    equip: uid("equip"),
    event: uid("event"),
  };
  await c.query(
    `INSERT INTO "Campus"(id,name,slug,"createdAt","updatedAt") VALUES($1,$1,$1,now(),now())`,
    [ids.campus],
  );
  await c.query(
    `INSERT INTO "Room"(id,slug,name,status,"hasProjector","hasMicrophony","hasBlackboard","hasWebConference","hasAutoRecording","mediaKeyRequired","createdAt","updatedAt")
     VALUES($1,$1,'R','ALL_GOOD',false,false,false,false,false,false,now(),now())`,
    [ids.room],
  );
  await c.query(
    `INSERT INTO "EquipmentModel"(id,name,category,"createdAt","updatedAt") VALUES($1,$1,'PROJECTOR',now(),now())`,
    [ids.model],
  );
  await c.query(
    `INSERT INTO "Equipment"(id,category,status,mobility,"modelId","createdAt","updatedAt")
     VALUES($1,'PROJECTOR','OPERATIONAL','POOLED',$2,now(),now())`,
    [ids.equip, ids.model],
  );
  await c.query(
    `INSERT INTO "Event"(id,uid,title,"startsAt","endsAt",status,"createdAt","updatedAt")
     VALUES($1,$1,'E',$2,$3,'PLANNED',now(),now())`,
    [ids.event, T.eventStart, T.eventEnd],
  );
  return ids;
}

function roomBooking(
  c: PoolClient,
  ev: string,
  room: string,
  start: string,
  end: string,
  cancelled = false,
) {
  return c.query(
    `INSERT INTO "EventRoomBooking"(id,"eventId","roomId","startsAt","endsAt",cancelled,"createdAt")
     VALUES($1,$2,$3,$4,$5,$6,now())`,
    [uid("erb"), ev, room, start, end, cancelled],
  );
}

function allocation(
  c: PoolClient,
  ev: string,
  equip: string,
  start: string,
  end: string,
  cancelled = false,
) {
  return c.query(
    `INSERT INTO "EquipmentAllocation"(id,"eventId","equipmentId","startsAt","endsAt",cancelled,"createdAt")
     VALUES($1,$2,$3,$4,$5,$6,now())`,
    [uid("alloc"), ev, equip, start, end, cancelled],
  );
}

describe("no-double-booking invariant (DB-enforced)", () => {
  it("both EXCLUDE constraints exist", async () => {
    const { rows } = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname IN ('event_room_no_overlap','equipment_alloc_no_overlap') ORDER BY conname`,
    );
    expect(rows.map((r) => r.conname)).toEqual([
      "equipment_alloc_no_overlap",
      "event_room_no_overlap",
    ]);
  });

  it("rejects overlapping room bookings with SQLSTATE 23P01", async () => {
    await inRolledBackTx(async (c) => {
      const ids = await seed(c);
      await roomBooking(c, ids.event, ids.room, "2026-07-01T10:00:00+02", "2026-07-01T12:00:00+02");
      await expect(
        roomBooking(c, ids.event, ids.room, "2026-07-01T11:00:00+02", "2026-07-01T13:00:00+02"),
      ).rejects.toMatchObject({ code: "23P01" });
    });
  });

  it("rejects overlapping pooled-equipment allocations with SQLSTATE 23P01", async () => {
    await inRolledBackTx(async (c) => {
      const ids = await seed(c);
      await allocation(c, ids.event, ids.equip, "2026-07-01T10:00:00+02", "2026-07-01T12:00:00+02");
      await expect(
        allocation(c, ids.event, ids.equip, "2026-07-01T11:30:00+02", "2026-07-01T13:00:00+02"),
      ).rejects.toMatchObject({ code: "23P01" });
    });
  });

  it("allows back-to-back touching bookings (half-open [) ranges)", async () => {
    await inRolledBackTx(async (c) => {
      const ids = await seed(c);
      await roomBooking(c, ids.event, ids.room, "2026-07-01T10:00:00+02", "2026-07-01T12:00:00+02");
      // touches at 12:00 — must NOT conflict
      await expect(
        roomBooking(c, ids.event, ids.room, "2026-07-01T12:00:00+02", "2026-07-01T14:00:00+02"),
      ).resolves.toBeDefined();
    });
  });

  it("exempts cancelled bookings from the overlap check", async () => {
    await inRolledBackTx(async (c) => {
      const ids = await seed(c);
      await roomBooking(
        c,
        ids.event,
        ids.room,
        "2026-07-01T10:00:00+02",
        "2026-07-01T12:00:00+02",
        true,
      );
      // overlaps the cancelled one, but the partial predicate (cancelled=false) excludes it
      await expect(
        roomBooking(
          c,
          ids.event,
          ids.room,
          "2026-07-01T11:00:00+02",
          "2026-07-01T13:00:00+02",
          false,
        ),
      ).resolves.toBeDefined();
    });
  });
});

describe("ActivityLog append-only (DB-enforced)", () => {
  async function insertLog(c: PoolClient) {
    const id = uid("log");
    await c.query(
      `INSERT INTO "ActivityLog"(id,action,"entityType","entityId","occurredAt","insertedAt")
       VALUES($1,'TestAction','Test',$1,now(),now())`,
      [id],
    );
    return id;
  }

  it("rejects UPDATE on ActivityLog", async () => {
    await inRolledBackTx(async (c) => {
      const id = await insertLog(c);
      await expect(
        c.query(`UPDATE "ActivityLog" SET action='Tampered' WHERE id=$1`, [id]),
      ).rejects.toMatchObject({ code: "23001" });
    });
  });

  it("rejects DELETE on ActivityLog", async () => {
    await inRolledBackTx(async (c) => {
      const id = await insertLog(c);
      await expect(c.query(`DELETE FROM "ActivityLog" WHERE id=$1`, [id])).rejects.toMatchObject({
        code: "23001",
      });
    });
  });
});
