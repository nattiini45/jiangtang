import { afterAll, describe, expect, it } from "vitest";
import { configuredCalendarFixture } from "../../../../test/calendar-config";

configuredCalendarFixture();
import {
  addRoomBooking,
  addServiceWindow,
  createEvent,
  createEventWithBooking,
} from "~/domains/events/events.mutations.server";
import {
  eventCreateSchema,
  serviceWindowSchema,
  type ServiceWindowInput,
} from "~/domains/events/events.schema";
import { RoomStatus } from "~/generated/prisma/enums";
import { t } from "~/i18n";
import { runWithLocale } from "~/i18n/request-locale.server";
import { db } from "~/lib/db.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { mcpError } from "~/lib/mcp/tools.server";

const run = `room_reference_${crypto.randomUUID()}`;
const actor = { id: null, name: run, initials: "RR" };
const interval = { startsAt: "2026-08-10T10:00", endsAt: "2026-08-10T12:00" };
const missingRoom = `${run}_missing`;
const eventWhere = { title: { startsWith: run } };
const auditWhere = { actorSnapshot: { path: ["name"], equals: run } };
const outboxWhere = { payload: { path: ["title"], string_starts_with: run } };

async function snapshot() {
  return {
    events: await db.event.findMany({ where: eventWhere, orderBy: { id: "asc" } }),
    bookings: await db.eventRoomBooking.findMany({
      where: { event: eventWhere },
      orderBy: { id: "asc" },
    }),
    serviceWindows: await db.serviceWindow.findMany({
      where: { event: eventWhere },
      orderBy: { id: "asc" },
    }),
    audit: await db.activityLog.findMany({ where: auditWhere, orderBy: { id: "asc" } }),
    outbox: await db.calendarOutbox.findMany({ where: outboxWhere, orderBy: { id: "asc" } }),
  };
}

afterAll(async () => {
  await db.serviceWindow.deleteMany({ where: { event: eventWhere } });
  await db.eventRoomBooking.deleteMany({ where: { event: eventWhere } });
  await db.calendarOutbox.deleteMany({ where: outboxWhere });
  await db.event.deleteMany({ where: eventWhere });
  await db.room.deleteMany({ where: { slug: { startsWith: run } } });
  await db.user.deleteMany({ where: { email: { startsWith: run } } });
  await db.$disconnect();
});

describe("service-window reference semantics", () => {
  it.each([
    ["roomId", "de"],
    ["roomId", "en"],
    ["coveringUserId", "de"],
    ["coveringUserId", "en"],
  ] as const)("rejects a missing service-window %s atomically in %s", async (field, locale) => {
    const event = await createEvent(
      actor,
      eventCreateSchema.parse({
        title: `${run} missing service ${field} ${locale}`,
        ...interval,
      }),
    );
    const input = serviceWindowSchema.parse({ [field]: `${run}_missing`, ...interval });
    const before = await snapshot();
    const error = await runWithLocale(locale, () => addServiceWindow(actor, event.id, input)).catch(
      (error: unknown) => error,
    );

    expect(await snapshot()).toEqual(before);
    expect(await db.serviceWindow.count({ where: { eventId: event.id } })).toBe(0);
    const response = runWithLocale(locale, () => toErrorResponse(error));
    expect(response.status).toBe(422);
    expect(error).toBeInstanceOf(ValidationError);
    const detail = {
      error: "ValidationError",
      message: t(locale, "err.validationFailed"),
      fieldErrors: {
        [field]: [t(locale, field === "roomId" ? "err.room.notFound" : "work.err.unknownUser")],
      },
      formErrors: [],
    };
    expect(await response.json()).toEqual(detail);
    expect(await runWithLocale(locale, () => mcpError(error))).toEqual({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ status: 422, detail }) }],
    });
  });

  it.each(Object.values(RoomStatus))(
    "accepts an existing %s room and an inactive covering user",
    async (status) => {
      const room = await db.room.create({
        data: { name: `${run} service ${status}`, slug: `${run}_service_${status}`, status },
      });
      const user = await db.user.create({
        data: { name: run, email: `${run}_${status}@example.test`, isActive: false },
      });
      const event = await createEvent(
        actor,
        eventCreateSchema.parse({ title: `${run} service ${status}`, ...interval }),
      );
      const outbox = await db.calendarOutbox.findMany({ where: { eventUid: event.uid } });
      const window = await addServiceWindow(
        actor,
        event.id,
        serviceWindowSchema.parse({
          roomId: room.id,
          coveringUserId: user.id,
          notes: "Synthetic service notes",
          ...interval,
        }),
      );

      expect(await db.serviceWindow.findUniqueOrThrow({ where: { id: window.id } })).toMatchObject({
        eventId: event.id,
        roomId: room.id,
        coveringUserId: user.id,
        kind: "SETUP",
        startsAt: new Date("2026-08-10T08:00:00Z"),
        endsAt: new Date("2026-08-10T10:00:00Z"),
        notes: "Synthetic service notes",
      });
      expect(
        await db.activityLog.findMany({
          where: { entityType: "serviceWindow", entityId: window.id },
        }),
      ).toEqual([
        expect.objectContaining({ action: "ServiceWindowAdded", data: { kind: "SETUP" } }),
      ]);
      expect(await db.calendarOutbox.findMany({ where: { eventUid: event.uid } })).toEqual(outbox);
    },
  );

  it.each([true, false])(
    "accepts a covering user with isActive=%s without a room",
    async (isActive) => {
      const user = await db.user.create({
        data: { name: run, email: `${run}_user_only_${isActive}@example.test`, isActive },
      });
      const event = await createEvent(
        actor,
        eventCreateSchema.parse({ title: `${run} user only ${isActive}`, ...interval }),
      );
      const window = await addServiceWindow(
        actor,
        event.id,
        serviceWindowSchema.parse({ coveringUserId: user.id, ...interval }),
      );
      expect(window).toMatchObject({ eventId: event.id, roomId: null, coveringUserId: user.id });
    },
  );

  it("accepts a room without a covering user", async () => {
    const room = await db.room.create({ data: { name: run, slug: `${run}_room_only` } });
    const event = await createEvent(
      actor,
      eventCreateSchema.parse({ title: `${run} room only`, ...interval }),
    );
    const window = await addServiceWindow(
      actor,
      event.id,
      serviceWindowSchema.parse({ roomId: room.id, ...interval }),
    );
    expect(window).toMatchObject({ eventId: event.id, roomId: room.id, coveringUserId: null });
  });

  it.each([
    ["omitted", {}],
    ["empty schema fields", { roomId: "", coveringUserId: "" }],
    ["runtime null", { roomId: null, coveringUserId: null }],
  ] as const)("retains absent references for %s", async (label, references) => {
    const event = await createEvent(
      actor,
      eventCreateSchema.parse({ title: `${run} absent ${label}`, ...interval }),
    );
    const input =
      label === "runtime null"
        ? ({ ...interval, kind: "SETUP", ...references } as unknown as ServiceWindowInput)
        : serviceWindowSchema.parse({ ...interval, ...references });
    const window = await addServiceWindow(actor, event.id, input);
    expect(window).toMatchObject({ eventId: event.id, roomId: null, coveringUserId: null });
  });

  it.each(["de", "en"] as const)(
    "keeps event errors ahead of both invalid service references in %s",
    async (locale) => {
      const event = await createEvent(
        actor,
        eventCreateSchema.parse({
          title: `${run} cancelled service ${locale}`,
          status: "CANCELLED",
          ...interval,
        }),
      );
      const input = serviceWindowSchema.parse({
        roomId: missingRoom,
        coveringUserId: `${run}_missing_user`,
        ...interval,
      });
      const before = await snapshot();
      const cancelled = await runWithLocale(locale, () =>
        addServiceWindow(actor, event.id, input),
      ).catch((error: unknown) => error);
      expect(cancelled).toBeInstanceOf(ValidationError);
      expect(cancelled).toMatchObject({
        fieldErrors: { eventId: [t(locale, "work.err.event.cancelled")] },
        formErrors: [],
      });
      expect(toErrorResponse(cancelled).status).toBe(422);
      const missing = await runWithLocale(locale, () =>
        addServiceWindow(actor, `${run}_missing_event`, input),
      ).catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(NotFoundError);
      expect(missing).toMatchObject({ message: t(locale, "work.err.event.notFound") });
      expect(toErrorResponse(missing).status).toBe(404);
      expect(await snapshot()).toEqual(before);
    },
  );
});

describe("room booking reference semantics", () => {
  it.each([
    ["initial", "de"],
    ["initial", "en"],
    ["later", "de"],
    ["later", "en"],
  ] as const)("rejects a missing room for %s bookings atomically in %s", async (seam, locale) => {
    const input = eventCreateSchema.parse({
      title: `${run} missing ${seam} ${locale}`,
      ...interval,
    });
    const event = seam === "later" ? await createEvent(actor, input) : undefined;
    const before = await snapshot();
    const error = await runWithLocale(locale, () =>
      event
        ? addRoomBooking(actor, event.id, { roomId: missingRoom, ...interval })
        : createEventWithBooking(actor, input, { roomId: missingRoom, ...interval }),
    ).catch((error: unknown) => error);

    expect(await snapshot()).toEqual(before);
    expect(await db.eventRoomBooking.count({ where: { roomId: missingRoom } })).toBe(0);
    const response = runWithLocale(locale, () => toErrorResponse(error));
    expect(response.status).toBe(422);
    expect(error).toBeInstanceOf(ValidationError);
    const detail = {
      error: "ValidationError",
      message: t(locale, "err.validationFailed"),
      fieldErrors: { roomId: [t(locale, "err.room.notFound")] },
      formErrors: [],
    };
    expect(await response.json()).toEqual(detail);
    const mcp = await runWithLocale(locale, () => mcpError(error));
    expect(mcp).toEqual({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ status: 422, detail }) }],
    });
  });

  it.each(Object.values(RoomStatus))("accepts existing %s rooms at both seams", async (status) => {
    const room = await db.room.create({
      data: { name: `${run} ${status}`, slug: `${run}_${status}`, status },
    });
    const input = eventCreateSchema.parse({ title: `${run} ${status}`, ...interval });
    const healthOverride =
      status === "OUT_OF_SERVICE"
        ? { healthOverrideConfirmed: true, healthOverrideReason: "Synthetic reference check" }
        : {};
    const event = await createEventWithBooking(actor, input, {
      roomId: room.id,
      ...interval,
      ...healthOverride,
    });
    const later = await addRoomBooking(actor, event.id, {
      roomId: room.id,
      startsAt: interval.endsAt,
      endsAt: "2026-08-10T13:00",
      ...healthOverride,
    });

    expect(await db.eventRoomBooking.findMany({ where: { eventId: event.id } })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ roomId: room.id, eventId: event.id, cancelled: false }),
        later,
      ]),
    );
    expect(await db.eventRoomBooking.count({ where: { eventId: event.id } })).toBe(2);
    expect(later).toMatchObject({ roomId: room.id, eventId: event.id, cancelled: false });
    const outbox = await db.calendarOutbox.findMany({
      where: { eventUid: event.uid },
      orderBy: { sequence: "asc" },
    });
    expect(outbox).toHaveLength(2);
    expect(outbox[0]).toMatchObject({ sequence: 0, payload: { location: room.name } });
    expect(outbox[1]).toMatchObject({ sequence: 1, payload: { location: room.name } });
    expect(
      await db.activityLog.count({
        where: { ...auditWhere, entityId: { in: [event.id, later.id] } },
      }),
    ).toBe(2);
  });

  it.each(["de", "en"] as const)(
    "keeps event errors ahead of missing rooms in %s",
    async (locale) => {
      const input = eventCreateSchema.parse({
        title: `${run} cancelled ${locale}`,
        status: "CANCELLED",
        ...interval,
      });
      const event = await createEvent(actor, input);
      const before = await snapshot();
      for (const operation of [
        () => createEventWithBooking(actor, input, { roomId: missingRoom, ...interval }),
        () => addRoomBooking(actor, event.id, { roomId: missingRoom, ...interval }),
      ]) {
        const error = await runWithLocale<Promise<unknown>>(locale, operation).catch(
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toMatchObject({
          fieldErrors: { eventId: [t(locale, "work.err.event.cancelled")] },
          formErrors: [],
        });
        expect(toErrorResponse(error).status).toBe(422);
        expect(await snapshot()).toEqual(before);
      }
      const error = await runWithLocale(locale, () =>
        addRoomBooking(actor, `${run}_missing_event`, { roomId: missingRoom, ...interval }),
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(NotFoundError);
      expect(error).toMatchObject({ message: t(locale, "work.err.event.notFound") });
      expect(toErrorResponse(error).status).toBe(404);
      expect(await snapshot()).toEqual(before);
    },
  );
});
