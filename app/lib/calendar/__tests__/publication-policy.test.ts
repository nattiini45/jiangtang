import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import {
  addRoomBooking,
  cancelEvent,
  cancelRoomBooking,
  createEvent,
  createEventWithBooking,
  updateEvent,
} from "~/domains/events/events.mutations.server";
import { eventCreateSchema } from "~/domains/events/events.schema";
import { getEventDetail } from "~/domains/events/events.queries.server";
import { initializeCalendarPublication } from "~/lib/calendar/initial-publication.server";
import { isCalendarConfigured } from "~/lib/calendar/config.server";
import { enqueueEventCalendarOp } from "~/lib/calendar/event-publication.server";
import type { Tx } from "~/lib/db.server";
import { DRAIN_LOCK_KEY, drainOnce } from "~/lib/calendar/outbox.server";
import * as publisher from "~/lib/calendar/publisher.server";
import type { EventStatus, OutboxStatus } from "~/generated/prisma/client";

const run = `publication-policy-${crypto.randomUUID()}`;
const actor = { name: run };
const now = new Date("2040-03-25T15:00:00Z");
const boundary = new Date("2040-03-24T23:00:00Z");
let roomId = "";
let room2Id = "";
const eventIds: string[] = [];
const uids: string[] = [];

function configured(value: boolean) {
  vi.stubEnv("CALDAV_URL", value ? "https://calendar.example.test/collection/" : "");
  vi.stubEnv("CALDAV_USERNAME", "synthetic-user");
  vi.stubEnv("CALDAV_PASSWORD", "synthetic-password");
}

const input = (suffix: string) =>
  eventCreateSchema.parse({
    title: `${run}-${suffix}`,
    startsAt: "2040-03-25T08:00",
    endsAt: "2040-03-25T20:00",
  });

async function fixture(suffix: string, endsAt: Date, status: EventStatus = "PLANNED") {
  const event = await db.event.create({
    data: {
      title: `${run}-${suffix}`,
      uid: `${run}-${suffix}`,
      status,
      startsAt: new Date(endsAt.getTime() - 3_600_000),
      endsAt,
    },
  });
  eventIds.push(event.id);
  uids.push(event.uid);
  return event;
}

async function row(
  eventUid: string,
  sequence: number,
  status: OutboxStatus = "PENDING",
  attempts = 0,
) {
  return db.calendarOutbox.create({
    data: {
      eventUid,
      sequence,
      op: "UPSERT",
      status,
      attempts,
      payload: { uid: eventUid, sequence, title: "Synthetic old snapshot" },
      lastError: attempts ? "synthetic failure" : null,
      lastAttemptAt: attempts ? now : null,
      nextAttemptAt: attempts ? new Date(now.getTime() + 60_000) : null,
      processedAt: status === "SENT" || status === "SUPERSEDED" ? now : null,
    },
  });
}

beforeAll(async () => {
  roomId = (await db.room.create({ data: { name: `${run} A`, slug: `${run}-a` } })).id;
  room2Id = (await db.room.create({ data: { name: `${run} B`, slug: `${run}-b` } })).id;
});

beforeEach(async () => {
  configured(false);
  await db.calendarPublicationInitialization.deleteMany();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.calendarPublicationInitialization.deleteMany();
  await db.calendarOutbox.deleteMany({ where: { eventUid: { in: uids } } });
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  eventIds.length = 0;
  uids.length = 0;
});

afterAll(async () => {
  await db.room.deleteMany({ where: { id: { in: [roomId, room2Id] } } });
  await db.$disconnect();
});

describe("unconfigured publication", () => {
  it("skips every producer before sequence allocation and keeps only business audits", async () => {
    const enqueue = vi.spyOn(publisher, "enqueueCalendarOp");
    const event = await createEvent(actor, input("disabled"));
    eventIds.push(event.id);
    uids.push(event.uid);
    const query = vi.fn();
    const tx = { $executeRaw: query } as unknown as Tx;
    await enqueueEventCalendarOp(tx, event, "UPSERT");
    await enqueueEventCalendarOp(tx, event, "REMOVE");
    expect(query).not.toHaveBeenCalled();
    await updateEvent(actor, event.id, { ...input("edited"), status: "CONFIRMED" });
    const booking = await addRoomBooking(actor, event.id, {
      roomId,
      startsAt: "2040-03-25T10:00",
      endsAt: "2040-03-25T11:00",
    });
    await cancelRoomBooking(actor, booking.id, event.id);
    await cancelEvent(actor, event.id);
    const initial = await createEventWithBooking(actor, input("initial"), {
      roomId,
      startsAt: "2040-03-25T12:00",
      endsAt: "2040-03-25T13:00",
    });
    eventIds.push(initial.id);
    uids.push(initial.uid);
    await updateEvent(actor, initial.id, { ...input("cancel-via-edit"), status: "CANCELLED" });
    expect(await db.calendarOutbox.count({ where: { eventUid: { in: uids } } })).toBe(0);
    const logs = await db.activityLog.findMany({
      where: { actorSnapshot: { path: ["name"], equals: run } },
      orderBy: { insertedAt: "asc" },
    });
    expect(logs.map((log) => log.action)).toEqual([
      "EventCreated",
      "EventUpdated",
      "RoomBooked",
      "RoomBookingCancelled",
      "EventCancelled",
      "EventCreated",
      "RoomBooked",
      "EventUpdated",
      "EventCancelled",
    ]);
    expect(enqueue).not.toHaveBeenCalled();
    expect((await getEventDetail(event.id))?.calendarSync).toEqual({
      configured: false,
      latest: null,
    });
    expect(await initializeCalendarPublication(now)).toBe(false);
    expect(await db.calendarPublicationInitialization.count()).toBe(0);
  });

  it("leaves retained sequence/history untouched while disabled, then resumes above its maximum", async () => {
    const event = await fixture("retained", now);
    const retained = await row(event.uid, 19, "SENT");
    await updateEvent(actor, event.id, input("disabled-update"));
    expect(await db.calendarOutbox.findMany({ where: { eventUid: event.uid } })).toEqual([
      retained,
    ]);
    expect((await getEventDetail(event.id))?.calendarSync).toMatchObject({
      configured: false,
      latest: { status: "SENT" },
    });
    configured(true);
    await updateEvent(actor, event.id, input("enabled-update"));
    expect((await getEventDetail(event.id))?.calendarSync).toMatchObject({
      configured: true,
      latest: { status: "PENDING" },
    });
    expect(
      await db.calendarOutbox.findFirst({
        where: { eventUid: event.uid },
        orderBy: { sequence: "desc" },
      }),
    ).toMatchObject({ sequence: 20 });
  });

  it("uses the complete shared config predicate", () => {
    expect(isCalendarConfigured()).toBe(false);
    configured(true);
    expect(isCalendarConfigured()).toBe(true);
    for (const key of ["CALDAV_URL", "CALDAV_USERNAME", "CALDAV_PASSWORD"]) {
      configured(true);
      vi.stubEnv(key, "");
      expect(isCalendarConfigured()).toBe(false);
    }
  });
});

describe("first configured publication", () => {
  it("audits all pending disposition, preserves every other row, and snapshots only Berlin-day candidates", async () => {
    const past = await fixture("past", new Date(boundary.getTime() - 1));
    const exact = await fixture("boundary", boundary);
    const overnight = await fixture("overnight", new Date(boundary.getTime() + 1));
    const today = await fixture("today", new Date("2040-03-25T09:00:00Z"), "DONE");
    const future = await fixture("future", new Date("2040-03-26T12:00:00Z"), "CONFIRMED");
    const active = await fixture("active", now, "IN_PROGRESS");
    const cancelled = await fixture("cancelled-unpublished", now, "CANCELLED");
    const publishedCancellation = await fixture("cancelled-published", now, "CANCELLED");
    const attemptedCancellation = await fixture("cancelled-attempted", now, "CANCELLED");
    const pastCancellation = await fixture("cancelled-past", boundary, "CANCELLED");
    const orphanUid = `${run}-orphan`;
    uids.push(orphanUid);
    const pending = await Promise.all([
      row(past.uid, 3),
      row(exact.uid, 0),
      row(overnight.uid, 4),
      row(today.uid, 8),
      row(cancelled.uid, 0),
      row(attemptedCancellation.uid, 4, "PENDING", 1),
      row(orphanUid, 0),
    ]);
    const history = await Promise.all([
      row(today.uid, 10, "SENT"),
      row(today.uid, 12, "FAILED", 10),
      row(today.uid, 14, "SUPERSEDED"),
      row(publishedCancellation.uid, 1, "SENT"),
      row(pastCancellation.uid, 9, "SENT"),
    ]);
    await db.eventRoomBooking.createMany({
      data: [roomId, room2Id].map((id) => ({
        eventId: future.id,
        roomId: id,
        startsAt: new Date("2040-03-26T10:00:00Z"),
        endsAt: new Date("2040-03-26T11:00:00Z"),
      })),
    });
    const existingAudit = await db.activityLog.create({
      data: {
        action: "EventCreated",
        entityType: "event",
        entityId: today.id,
        data: { synthetic: true },
      },
    });
    const http = vi.spyOn(globalThis, "fetch");
    configured(true);
    expect(await initializeCalendarPublication(now)).toBe(true);
    expect(http).not.toHaveBeenCalled();
    for (const previous of pending) {
      expect(await db.calendarOutbox.findUnique({ where: { id: previous.id } })).toEqual({
        ...previous,
        status: "SUPERSEDED",
        processedAt: now,
        nextAttemptAt: null,
      });
      expect(
        await db.activityLog.findMany({
          where: { entityType: "calendarOutbox", entityId: previous.id },
        }),
      ).toEqual([
        expect.objectContaining({
          action: "CalendarOutboxSuperseded",
          data: {
            reason: "first_configured_publication",
            eventUid: previous.eventUid,
            sequence: previous.sequence,
          },
        }),
      ]);
    }
    for (const previous of history)
      expect(await db.calendarOutbox.findUnique({ where: { id: previous.id } })).toEqual(previous);
    expect(await db.activityLog.findUnique({ where: { id: existingAudit.id } })).toEqual(
      existingAudit,
    );
    const snapshots = await db.calendarOutbox.findMany({
      where: { eventUid: { in: uids }, status: "PENDING" },
    });
    expect(snapshots).toHaveLength(6);
    expect(
      snapshots.find((snapshot) => snapshot.eventUid === attemptedCancellation.uid)?.nextAttemptAt,
    ).toEqual(new Date(now.getTime() + 60_000));
    expect(
      snapshots.map((snapshot) => [snapshot.eventUid, snapshot.op, snapshot.sequence]),
    ).toEqual(
      expect.arrayContaining([
        [overnight.uid, "UPSERT", 5],
        [today.uid, "UPSERT", 15],
        [future.uid, "UPSERT", 0],
        [active.uid, "UPSERT", 0],
        [publishedCancellation.uid, "REMOVE", 2],
        [attemptedCancellation.uid, "REMOVE", 5],
      ]),
    );
    const payload = snapshots.find((snapshot) => snapshot.eventUid === future.uid)!
      .payload as Record<string, unknown>;
    expect(String(payload.location).split(", ").sort()).toEqual([`${run} A`, `${run} B`]);
    expect(payload).toMatchObject({
      uid: future.uid,
      title: future.title,
      startsAt: future.startsAt.toISOString(),
      endsAt: future.endsAt.toISOString(),
      sequence: 0,
      timezone: "Europe/Berlin",
    });
    expect(await db.calendarPublicationInitialization.findMany()).toEqual([{ id: "caldav" }]);
    const audits = await db.activityLog.findMany({
      where: { action: "CalendarPublicationInitialized", entityId: { in: eventIds } },
    });
    expect(audits).toHaveLength(6);
    expect(
      audits.every(
        (log) => (log.data as Record<string, unknown>).boundary === boundary.toISOString(),
      ),
    ).toBe(true);
    const before = await db.calendarOutbox.findMany({ where: { eventUid: { in: uids } } });
    expect(await initializeCalendarPublication(new Date("2040-03-27T10:00:00Z"))).toBe(true);
    expect(await db.calendarOutbox.findMany({ where: { eventUid: { in: uids } } })).toEqual(before);
    expect(
      await db.activityLog.count({
        where: { action: "CalendarPublicationInitialized", entityId: { in: eventIds } },
      }),
    ).toBe(6);
    const fake = { upsert: vi.fn(), remove: vi.fn() };
    await drainOnce(fake, { now, eventUidPrefix: attemptedCancellation.uid });
    expect(fake.remove).not.toHaveBeenCalled();
    await drainOnce(fake, {
      now: new Date(now.getTime() + 60_000),
      eventUidPrefix: attemptedCancellation.uid,
    });
    expect(fake.remove).toHaveBeenCalledExactlyOnceWith(attemptedCancellation.uid, 5);
  });

  it("commits exactly one bootstrap under concurrent initializers", async () => {
    const event = await fixture("concurrent", now);
    configured(true);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => initializeCalendarPublication(now)),
    );
    expect(results).toContain(true);
    expect(await db.calendarPublicationInitialization.count()).toBe(1);
    expect(await db.calendarOutbox.findMany({ where: { eventUid: event.uid } })).toEqual([
      expect.objectContaining({ sequence: 0, status: "PENDING" }),
    ]);
    expect(
      await db.activityLog.count({
        where: { action: "CalendarPublicationInitialized", entityId: event.id },
      }),
    ).toBe(1);
  });

  it("rolls back disposition, snapshots, audits and marker together on failure, then retries", async () => {
    const event = await fixture("rollback", now);
    const previous = await row(event.uid, 8);
    const enqueue = publisher.enqueueCalendarOp;
    vi.spyOn(publisher, "enqueueCalendarOp").mockImplementationOnce(async (tx, operation) => {
      await enqueue(tx, operation);
      throw new Error("synthetic initialization failure");
    });
    configured(true);
    await expect(initializeCalendarPublication(now)).rejects.toThrow(
      "synthetic initialization failure",
    );
    expect(await db.calendarOutbox.findMany({ where: { eventUid: event.uid } })).toEqual([
      previous,
    ]);
    expect(
      await db.activityLog.count({ where: { entityId: { in: [event.id, previous.id] } } }),
    ).toBe(0);
    expect(await db.calendarPublicationInitialization.count()).toBe(0);
    expect(await initializeCalendarPublication(now)).toBe(true);
    expect(
      await db.calendarOutbox.count({
        where: { eventUid: event.uid, status: "PENDING", sequence: 9 },
      }),
    ).toBe(1);
  });

  it("skips immediately while the global drain lock is held", async () => {
    configured(true);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${DRAIN_LOCK_KEY}, 0))`;
      expect(await initializeCalendarPublication(now)).toBe(false);
      expect(await db.calendarPublicationInitialization.count()).toBe(0);
    });
  });

  it("waits for UID writes before reading the snapshot and retained sequence", async () => {
    const event = await fixture("uid-lock", now);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const writer = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${event.uid}, 0))`;
      locked();
      await held;
      await tx.event.update({ where: { id: event.id }, data: { title: `${run}-committed-title` } });
      await tx.calendarOutbox.create({
        data: { eventUid: event.uid, sequence: 22, op: "UPSERT", payload: {} },
      });
    });
    await ready;
    configured(true);
    const bootstrap = initializeCalendarPublication(now);
    try {
      await vi.waitFor(async () => {
        const rows = await db.$queryRaw<
          Array<{ count: bigint }>
        >`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        expect(Number(rows[0].count)).toBeGreaterThan(0);
      });
    } finally {
      release();
    }
    await writer;
    expect(await bootstrap).toBe(true);
    expect(
      await db.calendarOutbox.findMany({
        where: { eventUid: event.uid },
        orderBy: { sequence: "asc" },
      }),
    ).toEqual([
      expect.objectContaining({ sequence: 22, status: "SUPERSEDED" }),
      expect.objectContaining({
        sequence: 23,
        status: "PENDING",
        payload: expect.objectContaining({ title: `${run}-committed-title` }),
      }),
    ]);
  });
});
