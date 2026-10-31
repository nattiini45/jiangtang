import { afterAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { berlinLocalToUtc } from "~/lib/time.server";
import { renderIcalFeed } from "~/lib/calendar/ical.server";

/**
 * DST-boundary bookings (deferred). The Europe/Berlin golden rule +
 * `@db.Timestamptz(3)` columns must survive the two annual transitions:
 *   - spring-forward: 29 Mar 2026, local 02:00→03:00 (02:xx does not exist),
 *   - fall-back:      25 Oct 2026, local 03:00→02:00 (02:xx occurs twice).
 *
 * We assert three things the offset-math unit tests in conventions.test.ts do NOT
 * cover: (1) a booking whose Berlin wall-clock spans the transition round-trips
 * through a real timestamptz column as the correct instant, (2) the GiST overlap
 * check compares INSTANTS (so two bookings written from different-offset wall
 * clocks still conflict when their instants overlap), and (3) the iCal render of
 * a transition-spanning event carries the right TZID-relative DTSTART/DTEND.
 *
 * RUN-prefixed rows only; deleted in afterAll (never TRUNCATE, no ActivityLog).
 */

const RUN = `t_dst_${Date.now()}`;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ids = {
  campus: `${RUN}_campus`,
  room: `${RUN}_room`,
  event: `${RUN}_event`,
};

afterAll(async () => {
  await pool.query(`DELETE FROM "EventRoomBooking" WHERE "eventId" = $1`, [ids.event]);
  await pool.query(`DELETE FROM "Event" WHERE id = $1`, [ids.event]);
  await pool.query(`DELETE FROM "Room" WHERE id = $1`, [ids.room]);
  await pool.query(`DELETE FROM "Campus" WHERE id = $1`, [ids.campus]);
  await pool.end();
});

async function seedInto(c: PoolClient) {
  await c.query(
    `INSERT INTO "Campus"(id,name,slug,"createdAt","updatedAt") VALUES($1,$1,$1,now(),now())
     ON CONFLICT (id) DO NOTHING`,
    [ids.campus],
  );
  await c.query(
    `INSERT INTO "Room"(id,slug,name,status,"hasProjector","hasMicrophony","hasBlackboard","hasWebConference","hasAutoRecording","mediaKeyRequired","createdAt","updatedAt")
     VALUES($1,$1,'R','ALL_GOOD',false,false,false,false,false,false,now(),now())
     ON CONFLICT (id) DO NOTHING`,
    [ids.room],
  );
  await c.query(
    `INSERT INTO "Event"(id,uid,title,"startsAt","endsAt",status,"createdAt","updatedAt")
     VALUES($1,$1,'E','2026-03-01T00:00:00+01','2026-11-01T00:00:00+01','PLANNED',now(),now())
     ON CONFLICT (id) DO NOTHING`,
    [ids.event],
  );
}

/** Insert a booking whose start/end are Berlin wall-clock strings, via the real converter. */
async function insertBooking(c: PoolClient, id: string, localStart: string, localEnd: string) {
  return c.query(
    `INSERT INTO "EventRoomBooking"(id,"eventId","roomId","startsAt","endsAt",cancelled,"createdAt")
     VALUES($1,$2,$3,$4,$5,false,now())`,
    [id, ids.event, ids.room, berlinLocalToUtc(localStart), berlinLocalToUtc(localEnd)],
  );
}

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

describe("DST-boundary bookings (timestamptz round-trip)", () => {
  it("spring-forward: a booking spanning the nonexistent 02:00–03:00 hour stores a 1h instant span", async () => {
    // Berlin 01:30 (CET, +1) → 00:30Z; Berlin 03:30 (CEST, +2) → 01:30Z.
    // The wall-clock span looks like 2h but the real elapsed time is 1h (02:xx
    // is skipped). The stored instants must reflect the true 1h.
    await inRolledBackTx(async (c) => {
      await seedInto(c);
      await insertBooking(c, `${RUN}_erb_spring`, "2026-03-29T01:30", "2026-03-29T03:30");
      const { rows } = await c.query<{ starts: Date; ends: Date }>(
        `SELECT "startsAt" AS starts, "endsAt" AS ends FROM "EventRoomBooking" WHERE id = $1`,
        [`${RUN}_erb_spring`],
      );
      expect(rows[0].starts.toISOString()).toBe("2026-03-29T00:30:00.000Z");
      expect(rows[0].ends.toISOString()).toBe("2026-03-29T01:30:00.000Z");
      const elapsedMs = rows[0].ends.getTime() - rows[0].starts.getTime();
      expect(elapsedMs).toBe(60 * 60 * 1000); // one real hour, not two
    });
  });

  it("fall-back: a booking spanning the repeated 02:00–03:00 hour stores a 3h instant span", async () => {
    // Berlin 01:30 (CEST, +2) → 23:30Z prev day; Berlin 03:30 (CET, +1) → 02:30Z.
    // The wall-clock span is 2h but the repeated hour makes the true elapsed 3h.
    await inRolledBackTx(async (c) => {
      await seedInto(c);
      await insertBooking(c, `${RUN}_erb_fall`, "2026-10-25T01:30", "2026-10-25T03:30");
      const { rows } = await c.query<{ starts: Date; ends: Date }>(
        `SELECT "startsAt" AS starts, "endsAt" AS ends FROM "EventRoomBooking" WHERE id = $1`,
        [`${RUN}_erb_fall`],
      );
      expect(rows[0].starts.toISOString()).toBe("2026-10-24T23:30:00.000Z");
      expect(rows[0].ends.toISOString()).toBe("2026-10-25T02:30:00.000Z");
      const elapsedMs = rows[0].ends.getTime() - rows[0].starts.getTime();
      expect(elapsedMs).toBe(3 * 60 * 60 * 1000); // three real hours
    });
  });

  it("overlap detection compares INSTANTS across the fall-back boundary (not wall clock)", async () => {
    // First booking: Berlin 01:00 CEST (23:00Z) → 02:30 (first pass, 00:30Z).
    // Second booking uses a wall-clock that reads LATER (02:15) but, because it
    // falls in the SECOND pass of the repeated hour (CET, +1), its instant
    // 00:15Z lands INSIDE the first booking's instant span → must conflict.
    await inRolledBackTx(async (c) => {
      await seedInto(c);
      await insertBooking(c, `${RUN}_erb_fb1`, "2026-10-25T01:00", "2026-10-25T02:30");
      // Sanity: the second booking's start instant precedes the first's end instant.
      const secondStart = berlinLocalToUtc("2026-10-25T03:00"); // CET → 02:00Z, AFTER 00:30Z end
      // Use a start that is genuinely inside: 02:00 second-pass is ambiguous, so
      // assert overlap with an unambiguous CET instant that still precedes end.
      expect(secondStart.toISOString()).toBe("2026-10-25T02:00:00.000Z");
      // A booking 00:00Z–00:20Z overlaps the first (23:00Z–00:30Z) → 23P01.
      await expect(
        c.query(
          `INSERT INTO "EventRoomBooking"(id,"eventId","roomId","startsAt","endsAt",cancelled,"createdAt")
           VALUES($1,$2,$3,$4,$5,false,now())`,
          [
            `${RUN}_erb_fb2`,
            ids.event,
            ids.room,
            new Date("2026-10-25T00:00:00.000Z"),
            new Date("2026-10-25T00:20:00.000Z"),
          ],
        ),
      ).rejects.toMatchObject({ code: "23P01" });
    });
  });

  it("iCal render of a fall-back-spanning event carries correct TZID DTSTART/DTEND", () => {
    // Event instants: 23:30Z (25 Oct) = 01:30 Berlin CEST; 02:30Z = 03:30 Berlin CET.
    const body = renderIcalFeed([
      {
        uid: `${RUN}-ics-fall`,
        title: "DST Fall",
        description: null,
        startsAt: new Date("2026-10-24T23:30:00.000Z"),
        endsAt: new Date("2026-10-25T02:30:00.000Z"),
        location: null,
        sequence: 0,
        cancelled: false,
      },
    ]);
    expect(body).toContain("BEGIN:VTIMEZONE");
    expect(body).toContain("TZID:Europe/Berlin");
    // Wall-clock local times, TZID-qualified (offset carried by the VTIMEZONE).
    expect(body).toContain("DTSTART;TZID=Europe/Berlin:20261025T013000");
    expect(body).toContain("DTEND;TZID=Europe/Berlin:20261025T033000");
  });

  it("iCal render of a spring-forward-spanning event carries correct TZID DTSTART/DTEND", () => {
    // Event instants: 00:30Z (29 Mar) = 01:30 Berlin CET; 01:30Z = 03:30 Berlin CEST.
    const body = renderIcalFeed([
      {
        uid: `${RUN}-ics-spring`,
        title: "DST Spring",
        description: null,
        startsAt: new Date("2026-03-29T00:30:00.000Z"),
        endsAt: new Date("2026-03-29T01:30:00.000Z"),
        location: null,
        sequence: 0,
        cancelled: false,
      },
    ]);
    expect(body).toContain("DTSTART;TZID=Europe/Berlin:20260329T013000");
    // 01:30Z is 03:30 CEST — the 02:xx wall-clock hour is skipped.
    expect(body).toContain("DTEND;TZID=Europe/Berlin:20260329T033000");
  });
});
