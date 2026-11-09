import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
  type RouteObject,
} from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runWithLocale } from "~/i18n/request-locale.server";

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return {
    ...actual,
    requireUser: vi.fn(async () => ({ id: null, name: "Event Edit Tester", initials: "EE" })),
  };
});

const route = await import("~/routes/_desktop.events.$id/route");
const RUN = `event_edit_${Date.now()}`;
const eventIds: string[] = [];
const eventUids: string[] = [];
const roomIds: string[] = [];
let campusId: string;

beforeAll(async () => {
  const campus = await db.campus.create({ data: { name: RUN, slug: RUN } });
  campusId = campus.id;
});

afterAll(async () => {
  await db.calendarOutbox.deleteMany({ where: { eventUid: { in: eventUids } } });
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.campus.delete({ where: { id: campusId } });
  await db.$disconnect();
});

async function fixture(start: string, end: string) {
  const room = await db.room.create({
    data: { name: RUN, slug: `${RUN}-${roomIds.length}`, campusId },
  });
  roomIds.push(room.id);
  const event = await db.event.create({
    data: { title: RUN, startsAt: new Date(start), endsAt: new Date(end), status: "PLANNED" },
  });
  eventIds.push(event.id);
  eventUids.push(event.uid);
  const booking = await db.eventRoomBooking.create({
    data: {
      eventId: event.id,
      roomId: room.id,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
    },
  });
  return { event, booking };
}

async function renderEdit(id: string) {
  const data = await route.loader({
    params: { id },
    request: new Request(`http://localhost/events/${id}`),
  } as never);
  const routes: RouteObject[] = [
    {
      path: "/events/:id",
      Component: () => createElement(route.default, { loaderData: data } as never),
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://localhost/events/${id}`));
  if (context instanceof Response) throw new Error("Unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  const html = renderToStaticMarkup(
    createElement(StaticRouterProvider, { router, context, hydrate: false }),
  );
  const fields = { ...data.editDefaults, startsAtInstant: "", endsAtInstant: "" };
  for (const name of ["startsAtInstant", "endsAtInstant"] as const) {
    const input = html.match(/<input\b[^>]*>/g)?.find((tag) => tag.includes(`name="${name}"`));
    expect(input).toContain('type="hidden"');
    const value = input?.match(/value="([^"]*)"/)?.[1];
    expect(value).toBeDefined();
    fields[name] = value!;
  }
  return fields;
}

async function postEdit(id: string, fields: Record<string, string | null>) {
  const form = new FormData();
  form.set("_action", "updateEvent");
  for (const [key, value] of Object.entries(fields)) form.set(key, value ?? "");
  return route.action({
    params: { id },
    request: new Request(`http://localhost/events/${id}`, { method: "POST", body: form }),
  } as never);
}

describe("event edit exact instants", () => {
  it.each(["de", "en"] as const)(
    "keeps the existing inline validation presentation for a missing room in %s",
    async (locale) => {
      const { event } = await fixture("2026-07-04T08:00:00Z", "2026-07-04T10:00:00Z");
      const form = new FormData();
      form.set("_action", "addRoom");
      form.set("roomId", `${RUN}_missing`);
      form.set("startsAt", "2026-07-04T12:00");
      form.set("endsAt", "2026-07-04T13:00");
      const bookings = await db.eventRoomBooking.findMany({ where: { eventId: event.id } });
      const outbox = await db.calendarOutbox.findMany({ where: { eventUid: event.uid } });
      const logs = await db.activityLog.count({
        where: { action: "RoomBooked", data: { path: ["roomId"], equals: `${RUN}_missing` } },
      });

      const response = await runWithLocale(locale, () =>
        route.action({
          params: { id: event.id },
          request: new Request(`http://localhost/events/${event.id}`, {
            method: "POST",
            body: form,
            headers: { "Accept-Language": locale },
          }),
        } as never),
      ).catch((error: unknown) => error);

      expect(response).toEqual({ error: t(locale, "err.invalidInput") });
      expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
      expect(await db.eventRoomBooking.findMany({ where: { eventId: event.id } })).toEqual(
        bookings,
      );
      expect(await db.calendarOutbox.findMany({ where: { eventUid: event.uid } })).toEqual(outbox);
      expect(
        await db.activityLog.count({
          where: { action: "RoomBooked", data: { path: ["roomId"], equals: `${RUN}_missing` } },
        }),
      ).toBe(logs);
    },
  );

  it.each([
    ["first repeated hour", "2026-10-25T00:00:00.000Z", "2026-10-25T00:45:00.000Z"],
    ["second repeated hour", "2026-10-25T01:00:00.000Z", "2026-10-25T01:45:00.000Z"],
    ["across the fold", "2026-10-25T00:30:00.000Z", "2026-10-25T01:15:00.000Z"],
  ])("preserves event and booking ranges on title/status edits in %s", async (_, start, end) => {
    const { event, booking } = await fixture(start, end);
    for (const change of [{ title: `${RUN} renamed` }, { status: "CONFIRMED" }]) {
      const fields = await renderEdit(event.id);
      expect(fields.startsAtInstant).toBe(start);
      expect(fields.endsAtInstant).toBe(end);
      const response = await postEdit(event.id, { ...fields, ...change });
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).headers.get("location")).toBe(`/events/${event.id}`);
      const saved = await db.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(saved).toMatchObject(change);
      expect(saved.startsAt.toISOString()).toBe(start);
      expect(saved.endsAt.toISOString()).toBe(end);
      const savedBooking = await db.eventRoomBooking.findUniqueOrThrow({
        where: { id: booking.id },
      });
      expect(savedBooking.startsAt).toEqual(saved.startsAt);
      expect(savedBooking.endsAt).toEqual(saved.endsAt);
      expect(savedBooking.cancelled).toBe(false);
      const [range] = await db.$queryRaw<Array<{ start: Date; end: Date }>>`
        SELECT lower("during") AS start, upper("during") AS end
        FROM "EventRoomBooking" WHERE id = ${booking.id}
      `;
      expect(range).toEqual({ start: saved.startsAt, end: saved.endsAt });
      const op = await db.calendarOutbox.findFirstOrThrow({
        where: { eventUid: event.uid },
        orderBy: { sequence: "desc" },
      });
      expect(op.payload).toMatchObject({ startsAt: start, endsAt: end });
    }
  });

  it("ignores stale hints when either submitted local endpoint changes", async () => {
    const { event, booking } = await fixture(
      "2026-10-25T00:00:00.000Z",
      "2026-10-25T00:45:00.000Z",
    );
    const fields = await renderEdit(event.id);
    const response = await postEdit(event.id, {
      ...fields,
      startsAt: "2026-10-25T02:15",
      endsAt: "2026-10-25T03:30",
    });
    expect(response).toBeInstanceOf(Response);
    const saved = await db.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(saved.startsAt.toISOString()).toBe("2026-10-25T01:15:00.000Z");
    expect(saved.endsAt.toISOString()).toBe("2026-10-25T02:30:00.000Z");
    expect(await db.eventRoomBooking.findUniqueOrThrow({ where: { id: booking.id } })).toEqual(
      booking,
    );
  });
});
