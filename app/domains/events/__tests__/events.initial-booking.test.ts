import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configuredCalendarFixture } from "../../../../test/calendar-config";

configuredCalendarFixture();
import { createEventWithBooking } from "~/domains/events/events.mutations.server";
import { eventCreateSchema } from "~/domains/events/events.schema";
import { db } from "~/lib/db.server";
import { BookingConflictError } from "~/lib/errors.server";

const run = `initial_booking_${Date.now()}`;
const actor = { id: null, name: run, initials: "IB" };
const roomName = `${run} Room`;
let roomId = "";

beforeAll(async () => {
  const room = await db.room.create({ data: { name: roomName, slug: run } });
  roomId = room.id;
});

afterAll(async () => {
  const events = await db.event.findMany({ where: { title: { startsWith: run } } });
  const eventIds = events.map((event) => event.id);
  await db.calendarOutbox.deleteMany({
    where: { eventUid: { in: events.map((event) => event.uid) } },
  });
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.room.deleteMany({ where: { id: roomId } });
  await db.$disconnect();
});

describe("event creation with an initial room booking", () => {
  it("commits the event, booking, audit pair and exactly one initial outbox operation", async () => {
    const interval = { startsAt: "2026-07-01T10:00", endsAt: "2026-07-01T12:00" };
    const input = eventCreateSchema.parse({ title: `${run} committed`, ...interval });
    const event = await createEventWithBooking(actor, input, { roomId, ...interval });

    expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
    const bookings = await db.eventRoomBooking.findMany({ where: { eventId: event.id } });
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({
      eventId: event.id,
      roomId,
      cancelled: false,
      startsAt: new Date("2026-07-01T08:00:00Z"),
      endsAt: new Date("2026-07-01T10:00:00Z"),
    });

    const logs = await db.activityLog.findMany({
      where: {
        OR: [
          { entityType: "event", entityId: event.id },
          { entityType: "eventRoomBooking", entityId: bookings[0].id },
        ],
      },
    });
    expect(logs).toHaveLength(2);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "EventCreated",
          entityType: "event",
          entityId: event.id,
          data: { title: input.title },
          actorSnapshot: { name: actor.name, initials: actor.initials },
        }),
        expect.objectContaining({
          action: "RoomBooked",
          entityType: "eventRoomBooking",
          entityId: bookings[0].id,
          data: { roomId },
          actorSnapshot: { name: actor.name, initials: actor.initials },
        }),
      ]),
    );

    const outbox = await db.calendarOutbox.findMany({ where: { eventUid: event.uid } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      op: "UPSERT",
      sequence: 0,
      status: "PENDING",
      payload: { uid: event.uid, title: input.title, sequence: 0 },
    });
  });

  it("rolls back the event, booking, outbox and both audit writes on an exclusion conflict", async () => {
    const interval = { startsAt: "2026-07-02T10:00", endsAt: "2026-07-02T12:00" };
    const winner = await createEventWithBooking(
      actor,
      eventCreateSchema.parse({ title: `${run} winner`, ...interval }),
      { roomId, ...interval },
    );
    const bookingsBefore = await db.eventRoomBooking.findMany({ where: { roomId } });
    const auditWhere = { actorSnapshot: { path: ["name"], equals: actor.name } };
    const logsBefore = await db.activityLog.count({ where: auditWhere });
    const title = `${run} rejected`;

    await expect(
      createEventWithBooking(actor, eventCreateSchema.parse({ title, ...interval }), {
        roomId,
        ...interval,
      }),
    ).rejects.toBeInstanceOf(BookingConflictError);

    expect(await db.event.count({ where: { title } })).toBe(0);
    expect(await db.eventRoomBooking.findMany({ where: { roomId } })).toEqual(bookingsBefore);
    expect(
      await db.calendarOutbox.count({ where: { payload: { path: ["title"], equals: title } } }),
    ).toBe(0);
    expect(await db.activityLog.count({ where: auditWhere })).toBe(logsBefore);
    expect(await db.event.findUnique({ where: { id: winner.id } })).not.toBeNull();
    expect(await db.calendarOutbox.count({ where: { eventUid: winner.uid } })).toBe(1);
  });

  it("includes the initial booked room in the sequence-zero calendar snapshot", async () => {
    const input = eventCreateSchema.parse({
      title: `${run} calendar snapshot`,
      description: "Synthetic calendar description",
      startsAt: "2026-07-03T08:00",
      endsAt: "2026-07-03T20:00",
    });
    const event = await createEventWithBooking(actor, input, {
      roomId,
      startsAt: "2026-07-03T10:00",
      endsAt: "2026-07-03T12:00",
    });

    const outbox = await db.calendarOutbox.findMany({ where: { eventUid: event.uid } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ op: "UPSERT", sequence: 0, status: "PENDING" });
    expect(outbox[0].payload).toEqual({
      uid: event.uid,
      title: input.title,
      description: input.description,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      location: roomName,
      timezone: "Europe/Berlin",
      sequence: 0,
    });
  });
});
