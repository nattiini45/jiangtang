import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { berlinLocalToUtc } from "~/lib/time.server";
import { resolveEventTime } from "~/domains/events/events.time.server";
import {
  eventCreateSchema,
  eventEditSchema,
  roomBookingSchema,
} from "~/domains/events/events.schema";
import { eventCreationPrefill } from "~/domains/events/events.prefill.server";
import { findRoomConflicts } from "~/domains/events/events.availability.server";
import { t } from "~/i18n";
import { runWithLocale } from "~/i18n/request-locale.server";

vi.mock("~/lib/auth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/auth.server")>()),
  requireUser: vi.fn(async () => ({ id: null, name: "Creation Tester", initials: "CT" })),
}));

vi.mock("~/domains/events/events.availability.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/domains/events/events.availability.server")>();
  return { ...actual, findRoomConflicts: vi.fn(actual.findRoomConflicts) };
});

vi.mock("~/domains/notifications/notifications.mutations.server", () => ({
  notifyBookingConflict: vi.fn(),
}));

const desktop = await import("~/routes/_desktop.events.new/route");
const mobile = await import("~/routes/m.events.new/route");
const conflictRoute = await import("~/routes/api.events.check-conflict/route");
const RUN = `event_create_${Date.now()}`;
let roomId = "";

beforeAll(async () => {
  const room = await db.room.create({ data: { name: `${RUN} Room`, slug: RUN } });
  roomId = room.id;
});

afterAll(async () => {
  const events = await db.event.findMany({ where: { title: { startsWith: RUN } } });
  await db.eventRoomBooking.deleteMany({
    where: { eventId: { in: events.map((event) => event.id) } },
  });
  await db.calendarOutbox.deleteMany({
    where: { eventUid: { in: events.map((event) => event.uid) } },
  });
  await db.event.deleteMany({ where: { id: { in: events.map((event) => event.id) } } });
  if (roomId) await db.room.delete({ where: { id: roomId } });
  await db.$disconnect();
});

async function post(surface: "desktop" | "mobile", values: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(values)) body.set(key, value);
  const route = surface === "desktop" ? desktop : mobile;
  return route.action({
    request: new Request("http://localhost/events/new", { method: "POST", body }),
  } as never);
}

async function load(surface: "desktop" | "mobile", values: Record<string, string>) {
  const route = surface === "desktop" ? desktop : mobile;
  return route.loader({
    request: new Request(`http://localhost/events/new?${new URLSearchParams(values)}`),
  } as never);
}

describe("event creation prefills", () => {
  it("loads local desktop defaults and splits mobile defaults without changing Berlin time", async () => {
    const values = { startsAt: "2026-07-01T09:00", endsAt: "2026-07-01T10:00", roomId };
    expect((await load("desktop", values)).defaults).toMatchObject(values);
    expect((await load("mobile", values)).defaults).toMatchObject({
      date: "2026-07-01",
      startTime: "09:00",
      endTime: "10:00",
      roomId,
    });
    expect((await load("mobile", { date: "2026-10-25" })).defaults.date).toBe("2026-10-25");
  });

  it.each([
    ["2026-02-30T09:00", "2026-02-30T10:00"],
    ["2026-03-29T02:00", "2026-03-29T03:00"],
    ["2026-07-01T10:00", "2026-07-01T09:00"],
    ["2026-07-01T09:00", "invalid"],
  ])("does not invent a range for invalid inputs %s / %s", (startsAt, endsAt) => {
    expect(
      eventCreationPrefill(new URLSearchParams({ startsAt, endsAt, roomId: "missing" }), []),
    ).toMatchObject({
      startsAt: "",
      endsAt: "",
      roomId: "",
    });
  });

  it("keeps the selected date but leaves overnight mobile clocks blank", async () => {
    expect(
      (await load("mobile", { startsAt: "2026-07-01T23:00", endsAt: "2026-07-02T01:00" })).defaults,
    ).toMatchObject({
      date: "2026-07-01",
      startTime: "",
      endTime: "",
    });
    expect(eventCreationPrefill(new URLSearchParams({ date: "2026-02-30" }), []).date).toBe("");
  });

  it("retains both repeated autumn occurrences and uses real elapsed-time ordering", async () => {
    const result = await load("desktop", {
      startsAt: "2026-10-25T00:00:00.000Z",
      endsAt: "2026-10-25T01:00:00.000Z",
      roomId,
    });
    expect(result.defaults).toMatchObject({
      startsAt: "2026-10-25T02:00",
      endsAt: "2026-10-25T02:00",
      startsAtInstant: "2026-10-25T00:00:00.000Z",
      endsAtInstant: "2026-10-25T01:00:00.000Z",
    });
    expect(eventCreateSchema.safeParse({ title: "Synthetic", ...result.defaults }).success).toBe(
      true,
    );
    expect(eventEditSchema.safeParse({ title: "Synthetic", ...result.defaults }).success).toBe(
      true,
    );
    expect(roomBookingSchema.safeParse(result.defaults).success).toBe(false);
  });

  it("ignores mismatched instant hints and rejects malformed submitted hints", () => {
    const local = "2026-07-01T09:00";
    expect(resolveEventTime(local, "2026-10-25T00:00:00.000Z")).toEqual(berlinLocalToUtc(local));
    expect(resolveEventTime(local, "not-an-instant")).toEqual(berlinLocalToUtc(local));
    expect(
      eventCreateSchema.safeParse({
        title: "Synthetic",
        startsAt: local,
        endsAt: "2026-07-01T10:00",
        startsAtInstant: "invalid",
      }).success,
    ).toBe(false);
  });
});

describe("event creation actions", () => {
  it.each(["de", "en"] as const)(
    "returns localized missing-room fields on both surfaces in %s",
    async (locale) => {
      for (const surface of ["desktop", "mobile"] as const) {
        const title = `${RUN} missing room ${surface} ${locale}`;
        const result = await runWithLocale(locale, () =>
          post(surface, {
            title,
            roomId: `${RUN}_missing`,
            startsAt: "2026-07-04T10:00",
            endsAt: "2026-07-04T12:00",
            date: "2026-07-04",
            startTime: "10:00",
            endTime: "12:00",
          }),
        );
        expect(result).toMatchObject({ fieldErrors: { roomId: [t(locale, "err.room.notFound")] } });
        expect(await db.event.count({ where: { title } })).toBe(0);
        expect(await db.eventRoomBooking.count({ where: { roomId: `${RUN}_missing` } })).toBe(0);
        expect(
          await db.activityLog.count({
            where: { action: "EventCreated", data: { path: ["title"], equals: title } },
          }),
        ).toBe(0);
        expect(
          await db.calendarOutbox.count({
            where: { payload: { path: ["title"], equals: title } },
          }),
        ).toBe(0);
      }
    },
  );

  it("still creates an event without a room", async () => {
    const title = `${RUN} unbooked`;
    expect(
      await post("desktop", {
        title,
        startsAt: "2026-10-25T02:00",
        endsAt: "2026-10-25T02:30",
        startsAtInstant: "2026-10-25T00:00:00.000Z",
        endsAtInstant: "2026-10-25T00:30:00.000Z",
      }),
    ).toBeInstanceOf(Response);
    const event = await db.event.findFirstOrThrow({ where: { title } });
    expect(event.startsAt.toISOString()).toBe("2026-10-25T00:00:00.000Z");
    expect(await db.eventRoomBooking.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("books a positive elapsed range even when the autumn wall clock moves backward", async () => {
    const title = `${RUN} backward clock`;
    expect(
      await post("desktop", {
        title,
        roomId,
        startsAt: "2026-10-25T02:45",
        endsAt: "2026-10-25T02:00",
        startsAtInstant: "2026-10-25T00:45:00.000Z",
        endsAtInstant: "2026-10-25T01:00:00.000Z",
      }),
    ).toBeInstanceOf(Response);
    const event = await db.event.findFirstOrThrow({ where: { title } });
    expect(event.endsAt.getTime() - event.startsAt.getTime()).toBe(15 * 60_000);
  });

  it("books both autumn occurrences separately and checks availability against the same instants", async () => {
    for (const hour of ["00", "01"]) {
      const title = `${RUN} occurrence ${hour}`;
      const startsAtInstant = `2026-10-25T${hour}:00:00.000Z`;
      const endsAtInstant = `2026-10-25T${hour}:30:00.000Z`;
      expect(
        await post("desktop", {
          title,
          roomId,
          startsAt: "2026-10-25T02:00",
          endsAt: "2026-10-25T02:30",
          startsAtInstant,
          endsAtInstant,
        }),
      ).toBeInstanceOf(Response);
      const event = await db.event.findFirstOrThrow({
        where: { title },
        include: { rooms: true },
      });
      expect(event.startsAt.toISOString()).toBe(startsAtInstant);
      expect(event.rooms[0].startsAt).toEqual(event.startsAt);
      const params = new URLSearchParams({
        kind: "room",
        id: roomId,
        startsAt: "2026-10-25T02:00",
        endsAt: "2026-10-25T02:30",
        startsAtInstant,
        endsAtInstant,
      });
      const response = await conflictRoute.loader({
        request: new Request(`http://localhost/api/events/check-conflict?${params}`),
      } as never);
      const data = await response.json();
      expect(data.conflicts.map((conflict: { eventId: string }) => conflict.eventId)).toEqual([
        event.id,
      ]);
    }
  });

  it("rolls back event, audit and outbox when the authoritative booking insert conflicts", async () => {
    const title = `${RUN} rejected`;
    const result = await post("desktop", {
      title,
      roomId,
      startsAt: "2026-10-25T02:00",
      endsAt: "2026-10-25T02:30",
      startsAtInstant: "2026-10-25T00:00:00.000Z",
      endsAtInstant: "2026-10-25T00:30:00.000Z",
    });
    expect(result).toMatchObject({ conflict: true });
    expect(await db.event.count({ where: { title } })).toBe(0);
    expect(
      await db.activityLog.count({
        where: { action: "EventCreated", data: { path: ["title"], equals: title } },
      }),
    ).toBe(0);
    expect(
      await db.calendarOutbox.count({ where: { payload: { path: ["title"], equals: title } } }),
    ).toBe(0);
  });

  it("creates mobile bookings with exact prefills and handles both pre-check and race conflicts", async () => {
    const values = {
      roomId,
      date: "2026-10-25",
      startTime: "02:30",
      endTime: "02:45",
      startsAtInstant: "2026-10-25T00:30:00.000Z",
      endsAtInstant: "2026-10-25T00:45:00.000Z",
    };
    const created = await post("mobile", { title: `${RUN} mobile`, ...values });
    expect(created).toBeInstanceOf(Response);
    expect((created as Response).headers.get("Location")).toBe(`/m/calendar?date=${values.date}`);
    expect(await post("mobile", { title: `${RUN} mobile precheck`, ...values })).toMatchObject({
      conflict: true,
    });
    vi.mocked(findRoomConflicts).mockResolvedValueOnce([]);
    const title = `${RUN} mobile race`;
    expect(await post("mobile", { title, ...values })).toMatchObject({ conflict: true });
    expect(await db.event.count({ where: { title } })).toBe(0);
  });

  it("falls back to edited local fields instead of honoring a stale hidden instant", async () => {
    const title = `${RUN} edited`;
    expect(
      await post("desktop", {
        title,
        roomId,
        startsAt: "2026-07-02T09:00",
        endsAt: "2026-07-02T10:00",
        startsAtInstant: "2026-10-25T00:00:00.000Z",
        endsAtInstant: "2026-10-25T00:30:00.000Z",
      }),
    ).toBeInstanceOf(Response);
    const event = await db.event.findFirstOrThrow({ where: { title } });
    expect(event.startsAt).toEqual(berlinLocalToUtc("2026-07-02T09:00"));
  });
});
