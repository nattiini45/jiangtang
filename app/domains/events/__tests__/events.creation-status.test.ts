import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addRoomBooking,
  cancelEvent,
  createEvent,
  createEventWithBooking,
  updateEvent,
} from "~/domains/events/events.mutations.server";
import { eventCreateSchema } from "~/domains/events/events.schema";
import { EventStatus } from "~/generated/prisma/enums";
import { t } from "~/i18n";
import { runWithLocale } from "~/i18n/request-locale.server";
import { db } from "~/lib/db.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";

const run = `creation_status_${Date.now()}`;
const actor = { id: null, name: run, initials: "CS" };
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

describe("event creation statuses", () => {
  it.each(Object.values(EventStatus))("allows %s creation without a room", async (status) => {
    const input = eventCreateSchema.parse({
      title: `${run} no room ${status}`,
      startsAt: "2026-08-01T08:00",
      endsAt: "2026-08-01T20:00",
      status,
    });
    const event = await createEvent(actor, input);

    expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
    expect(event.status).toBe(status);
    expect(await db.eventRoomBooking.count({ where: { eventId: event.id } })).toBe(0);
    const logs = await db.activityLog.findMany({
      where: { entityType: "event", entityId: event.id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "EventCreated",
      data: { title: input.title },
      actorSnapshot: { name: actor.name, initials: actor.initials },
    });
    const outbox = await db.calendarOutbox.findMany({ where: { eventUid: event.uid } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ op: "UPSERT", sequence: 0, status: "PENDING" });
    expect(outbox[0].payload).toEqual({
      uid: event.uid,
      title: input.title,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      timezone: "Europe/Berlin",
      sequence: 0,
    });
  });

  it.each([
    [EventStatus.PLANNED, "2026-08-02"],
    [EventStatus.CONFIRMED, "2026-08-03"],
    [EventStatus.IN_PROGRESS, "2026-08-04"],
    [EventStatus.DONE, "2026-08-05"],
  ])("allows %s creation with an active initial booking", async (status, date) => {
    const input = eventCreateSchema.parse({
      title: `${run} initial room ${status}`,
      startsAt: `${date}T08:00`,
      endsAt: `${date}T20:00`,
      status,
    });
    const event = await createEventWithBooking(actor, input, {
      roomId,
      startsAt: `${date}T10:00`,
      endsAt: `${date}T12:00`,
    });

    expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
    expect(event.status).toBe(status);
    const bookings = await db.eventRoomBooking.findMany({ where: { eventId: event.id } });
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({
      roomId,
      cancelled: false,
      startsAt: new Date(`${date}T08:00:00Z`),
      endsAt: new Date(`${date}T10:00:00Z`),
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
    expect(outbox[0]).toMatchObject({ op: "UPSERT", sequence: 0, status: "PENDING" });
    expect(outbox[0].payload).toEqual({
      uid: event.uid,
      title: input.title,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      location: roomName,
      timezone: "Europe/Berlin",
      sequence: 0,
    });
  });

  it.each(["de", "en"] as const)(
    "rejects CANCELLED creation with an initial room atomically in %s",
    async (locale) => {
      const date = locale === "de" ? "2026-08-07" : "2026-08-08";
      const interval = { startsAt: `${date}T10:00`, endsAt: `${date}T12:00` };
      const input = eventCreateSchema.parse({
        title: `${run} rejected ${locale}`,
        status: "CANCELLED",
        ...interval,
      });
      const bookingsBefore = await db.eventRoomBooking.findMany({ where: { roomId } });
      const auditWhere = { actorSnapshot: { path: ["name"], equals: actor.name } };
      const logsBefore = await db.activityLog.count({ where: auditWhere });

      const result = await runWithLocale(locale, () =>
        createEventWithBooking(actor, input, { roomId, ...interval }),
      ).catch((error: unknown) => error);

      expect({
        result,
        bookings: await db.eventRoomBooking.findMany({ where: { roomId } }),
      }).toEqual({ result: expect.any(ValidationError), bookings: bookingsBefore });
      const fieldErrors = { eventId: [t(locale, "work.err.event.cancelled")] };
      expect(result).toMatchObject({ fieldErrors, formErrors: [] });
      const response = runWithLocale(locale, () => toErrorResponse(result));
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: "ValidationError",
        message: t(locale, "err.validationFailed"),
        fieldErrors,
        formErrors: [],
      });
      expect(await db.event.count({ where: { title: input.title } })).toBe(0);
      expect(
        await db.calendarOutbox.count({
          where: { payload: { path: ["title"], equals: input.title } },
        }),
      ).toBe(0);
      expect(await db.activityLog.count({ where: auditWhere })).toBe(logsBefore);
    },
  );

  it("keeps cancelled bookings cancelled on reopen and allows a new explicit booking", async () => {
    const interval = { startsAt: "2026-08-06T10:00", endsAt: "2026-08-06T12:00" };
    const input = eventCreateSchema.parse({ title: `${run} reopen`, ...interval });
    const event = await createEventWithBooking(actor, input, { roomId, ...interval });
    const initialBooking = await db.eventRoomBooking.findFirstOrThrow({
      where: { eventId: event.id },
    });

    await cancelEvent(actor, event.id);
    const reopened = await updateEvent(actor, event.id, { ...input, status: "CONFIRMED" });

    expect(reopened.status).toBe("CONFIRMED");
    expect(await db.eventRoomBooking.findMany({ where: { eventId: event.id } })).toEqual([
      { ...initialBooking, cancelled: true },
    ]);
    const outbox = await db.calendarOutbox.findMany({
      where: { eventUid: event.uid },
      orderBy: { sequence: "asc" },
    });
    expect(outbox.map(({ op, sequence }) => ({ op, sequence }))).toEqual([
      { op: "UPSERT", sequence: 0 },
      { op: "REMOVE", sequence: 1 },
      { op: "UPSERT", sequence: 2 },
    ]);
    expect(outbox[2].payload).not.toHaveProperty("location");

    const newBooking = await addRoomBooking(actor, event.id, { roomId, ...interval });
    expect(newBooking).toMatchObject({ eventId: event.id, roomId, cancelled: false });
    expect(newBooking.id).not.toBe(initialBooking.id);
    expect(
      await db.eventRoomBooking.findUniqueOrThrow({ where: { id: initialBooking.id } }),
    ).toMatchObject({ cancelled: true });
    const latest = await db.calendarOutbox.findFirstOrThrow({
      where: { eventUid: event.uid },
      orderBy: { sequence: "desc" },
    });
    expect(latest).toMatchObject({
      op: "UPSERT",
      sequence: 3,
      payload: { location: roomName, sequence: 3 },
    });
  });
});
