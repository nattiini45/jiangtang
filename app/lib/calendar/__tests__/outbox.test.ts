import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { drainOnce } from "~/lib/calendar/outbox.server";
import type { CalendarPayload, CalendarPublisher } from "~/lib/calendar/publisher.server";
import { createEvent, cancelEvent, updateEvent } from "~/domains/events/events.mutations.server";
import type { EventCreateInput } from "~/domains/events/events.schema";

/**
 * Outbox drain worker. Two layers:
 *  - pure/injectable drain over hand-seeded rows: ordering per uid, poison
 *    parking at MAX_ATTEMPTS, blocking of later sequences by a failed lower one;
 *  - a dev-DB integration pass that enqueues REAL outbox rows via the events
 *    domain mutations, then drains through a FakePublisher and asserts the ops
 *    arrive in (uid, sequence) order and the rows flip to SENT.
 *
 * Isolation: every uid/id is prefixed with a unique RUN constant; afterAll deletes
 * only this run's rows (outbox + events); ActivityLog is append-only (untouched).
 */

const RUN = `t7ob_${Date.now()}`;

/** Records every publish call in order; can be told to fail. */
class FakePublisher implements CalendarPublisher {
  calls: Array<{ op: "UPSERT" | "REMOVE"; uid: string; sequence: number }> = [];
  constructor(private readonly fail: (uid: string, sequence: number) => boolean = () => false) {}
  async upsert(payload: CalendarPayload): Promise<void> {
    if (this.fail(payload.uid, payload.sequence)) throw new Error("boom");
    this.calls.push({ op: "UPSERT", uid: payload.uid, sequence: payload.sequence });
  }
  async remove(uid: string, sequence: number): Promise<void> {
    if (this.fail(uid, sequence)) throw new Error("boom");
    this.calls.push({ op: "REMOVE", uid, sequence });
  }
}

const seededOutboxIds: string[] = [];
const seededEventIds: string[] = [];
// Real events get a cuid `uid` (not RUN-prefixed), so track them for outbox cleanup.
const seededEventUids: string[] = [];

function jsonPayload(
  uid: string,
  sequence: number,
): CalendarPayload & { startsAt: string; endsAt: string } {
  return {
    uid,
    title: `${uid} Titel`,
    startsAt: new Date("2026-09-01T08:00:00Z").toISOString(),
    endsAt: new Date("2026-09-01T10:00:00Z").toISOString(),
    location: "Raum 1",
    timezone: "Europe/Berlin",
    sequence,
  } as CalendarPayload & { startsAt: string; endsAt: string };
}

async function seed(
  uid: string,
  sequence: number,
  over?: { op?: "UPSERT" | "REMOVE"; status?: "PENDING" | "FAILED"; attempts?: number },
): Promise<string> {
  const row = await db.calendarOutbox.create({
    data: {
      op: over?.op ?? "UPSERT",
      eventUid: uid,
      sequence,
      status: over?.status ?? "PENDING",
      attempts: over?.attempts ?? 0,
      payload: jsonPayload(uid, sequence) as object,
    },
  });
  seededOutboxIds.push(row.id);
  return row.id;
}

afterAll(async () => {
  await db.calendarOutbox.deleteMany({ where: { id: { in: seededOutboxIds } } });
  await db.calendarOutbox.deleteMany({ where: { eventUid: { startsWith: RUN } } });
  await db.calendarOutbox.deleteMany({ where: { eventUid: { in: seededEventUids } } });
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: seededEventIds } } });
  await db.event.deleteMany({ where: { id: { in: seededEventIds } } });
  await db.$disconnect();
});

describe("drainOnce (seeded rows)", () => {
  it("dispatches a uid's sequences in order and marks them SENT", async () => {
    const uid = `${RUN}_ord`;
    const id0 = await seed(uid, 0);
    const id1 = await seed(uid, 1);
    const fake = new FakePublisher();

    const res = await drainOnce(fake, { batchSize: 100, eventUidPrefix: RUN });
    expect(res.sent).toBeGreaterThanOrEqual(2);
    // Both sent, in ascending sequence order for this uid.
    const mine = fake.calls.filter((c) => c.uid === uid);
    expect(mine.map((c) => c.sequence)).toEqual([0, 1]);

    const rows = await db.calendarOutbox.findMany({ where: { id: { in: [id0, id1] } } });
    expect(rows.every((r) => r.status === "SENT" && r.processedAt !== null)).toBe(true);
  });

  it("never dispatches seq 1 before seq 0 lands, and blocks 1 while 0 is FAILED", async () => {
    const uid = `${RUN}_block`;
    // seq 0 fails (transient), seq 1 must be skipped this pass.
    await seed(uid, 0);
    await seed(uid, 1);
    const failSeq0 = new FakePublisher((u, s) => u === uid && s === 0);

    const res = await drainOnce(failSeq0, { batchSize: 100, eventUidPrefix: RUN });
    // seq 0 failed → seq 1 skipped; seq 1 was never published.
    expect(failSeq0.calls.filter((c) => c.uid === uid)).toHaveLength(0);
    expect(res.skipped).toBeGreaterThanOrEqual(1);

    const rows = await db.calendarOutbox.findMany({
      where: { eventUid: uid },
      orderBy: { sequence: "asc" },
    });
    expect(rows[0].status).toBe("PENDING"); // seq 0 still pending (attempts=1)
    expect(rows[0].attempts).toBe(1);
    expect(rows[1].status).toBe("PENDING"); // seq 1 untouched
  });

  it("blocks a higher sequence while a lower one is already FAILED (poison)", async () => {
    const uid = `${RUN}_poison_block`;
    await seed(uid, 0, { status: "FAILED", attempts: 5 });
    const id1 = await seed(uid, 1);
    const fake = new FakePublisher();

    await drainOnce(fake, { batchSize: 100, eventUidPrefix: RUN });
    expect(fake.calls.filter((c) => c.uid === uid)).toHaveLength(0);
    const row1 = await db.calendarOutbox.findUniqueOrThrow({ where: { id: id1 } });
    expect(row1.status).toBe("PENDING");
  });

  it("parks an always-failing row as FAILED at attempts=5, then skips it", async () => {
    const uid = `${RUN}_poison`;
    // Start at attempts=4 so a single failing drain reaches 5 → FAILED. A future
    // `now` clears the backoff gate for the already-retried row.
    const id = await seed(uid, 0, { attempts: 4 });
    const alwaysFail = new FakePublisher(() => true);
    const future = new Date(Date.now() + 2 * 60 * 60_000); // > backoff cap (~1h)

    await drainOnce(alwaysFail, { batchSize: 100, eventUidPrefix: RUN, now: future });
    let row = await db.calendarOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.attempts).toBe(5);
    expect(row.status).toBe("FAILED");
    expect(row.lastError).toContain("boom");

    // A subsequent drain never re-dispatches a FAILED row.
    const fake2 = new FakePublisher();
    await drainOnce(fake2, { batchSize: 100, eventUidPrefix: RUN });
    expect(fake2.calls.filter((c) => c.uid === uid)).toHaveLength(0);
    row = await db.calendarOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("FAILED");
  });

  it("re-PUTs the same row after a transient failure: PENDING → SENT (idempotent target)", async () => {
    const uid = `${RUN}_retry`;
    const id = await seed(uid, 0);
    // First pass fails.
    await drainOnce(new FakePublisher(() => true), { batchSize: 100, eventUidPrefix: RUN });
    let row = await db.calendarOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(1);

    // Second pass succeeds; backoff is due because we pass a future `now`.
    const fake = new FakePublisher();
    const future = new Date(Date.now() + 10 * 60_000);
    await drainOnce(fake, { batchSize: 100, now: future, eventUidPrefix: RUN });
    expect(fake.calls.filter((c) => c.uid === uid)).toEqual([{ op: "UPSERT", uid, sequence: 0 }]);
    row = await db.calendarOutbox.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("SENT");
  });
});

// ── Integration: real outbox rows from domain mutations ───────────────────────

function eventInput(title: string): EventCreateInput {
  return {
    title,
    description: undefined,
    startsAt: "2026-09-10T08:00",
    endsAt: "2026-09-10T20:00",
    status: "PLANNED",
    organizer: undefined,
    contact: undefined,
  };
}

describe("drainOnce (integration with events domain)", () => {
  const actor = { id: null as string | null, name: "Outbox Tester", initials: "OT" };

  it("drains rows enqueued by createEvent/updateEvent/cancelEvent in (uid, sequence) order", async () => {
    const created = await createEvent(actor, eventInput(`${RUN} Integ`));
    seededEventIds.push(created.id);
    seededEventUids.push(created.uid);
    // update → UPSERT seq 1; cancel → REMOVE seq 2.
    await updateEvent(actor, created.id, { ...eventInput(`${RUN} Integ v2`), status: "PLANNED" });
    await cancelEvent(actor, created.id);

    const before = await db.calendarOutbox.findMany({
      where: { eventUid: created.uid },
      orderBy: { sequence: "asc" },
    });
    // afterAll cleans these up via seededEventUids (the cuid uid, tracked above).
    expect(before.map((r) => r.op)).toEqual(["UPSERT", "UPSERT", "REMOVE"]);
    expect(before.every((r) => r.status === "PENDING")).toBe(true);

    // Scope the drain to THIS event's uid so parallel tracks' PENDING rows are untouched.
    const fake = new FakePublisher();
    await drainOnce(fake, { batchSize: 100, eventUidPrefix: created.uid });

    const mine = fake.calls.filter((c) => c.uid === created.uid);
    expect(mine).toEqual([
      { op: "UPSERT", uid: created.uid, sequence: 0 },
      { op: "UPSERT", uid: created.uid, sequence: 1 },
      { op: "REMOVE", uid: created.uid, sequence: 2 },
    ]);

    const after = await db.calendarOutbox.findMany({ where: { eventUid: created.uid } });
    expect(after.every((r) => r.status === "SENT")).toBe(true);
  });
});
