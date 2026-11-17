import { afterAll, beforeAll, expect, it } from "vitest";
import { configuredCalendarFixture } from "../../../../test/calendar-config";
import { getWorkspaceCalendar } from "~/domains/calendar/calendar.queries.server";
import { loadFeedEvents, renderIcalFeed } from "~/lib/calendar/ical.server";
import { db } from "~/lib/db.server";
import { occurrenceTimes, seriesDates } from "../event-series.dates.server";
import {
  changeEventSeries,
  createEventSeries,
  extendEventSeries,
} from "../event-series.mutations.server";
import { eventSeriesSchema, seriesEventSchema } from "../event-series.schema";
import { getEventDetail } from "../events.queries.server";
import {
  addAllocation,
  createEvent,
  createEventWithBooking,
  updateEvent,
} from "../events.mutations.server";

configuredCalendarFixture();
const title = `series-${crypto.randomUUID()}`;
const actor = { name: "Synthetic scheduler" };
const now = new Date("2026-01-02T12:00:00Z");
let roomId: string;
let equipmentId: string;
const seriesIds: string[] = [];
const eventAt = (date: string, start = "10:00", end = "11:00") =>
  seriesEventSchema.parse({ title, startsAt: `${date}T${start}`, endsAt: `${date}T${end}` });
const eventsIn = (seriesId: string) =>
  db.event.findMany({ where: { seriesId }, orderBy: { occurrenceKey: "asc" } });

beforeAll(async () => {
  roomId = (await db.room.create({ data: { name: title, slug: title } })).id;
  equipmentId = (
    await db.equipment.create({
      data: { name: title, category: "PROJECTOR", mobility: "POOLED", status: "OPERATIONAL" },
    })
  ).id;
});

afterAll(async () => {
  const events = await db.event.findMany({ where: { title }, select: { id: true, uid: true } });
  const where = { eventId: { in: events.map(({ id }) => id) } };
  await db.calendarOutbox.deleteMany({ where: { eventUid: { in: events.map(({ uid }) => uid) } } });
  await db.eventRoomBooking.deleteMany({ where });
  await db.equipmentAllocation.deleteMany({ where });
  await db.serviceWindow.deleteMany({ where });
  await db.event.deleteMany({ where: { title } });
  await db.eventSeries.deleteMany({ where: { id: { in: seriesIds } } });
  await db.room.deleteMany({ where: { id: roomId } });
  await db.equipment.deleteMany({ where: { id: equipmentId } });
});

it("keeps wall time over both DST changes and skips missing month dates", () => {
  const event = eventAt("2026-01-31");
  const monthly = eventSeriesSchema.parse({
    event,
    rule: { frequency: "monthly" },
    end: { kind: "date", date: "2026-05-31" },
  });
  expect([...seriesDates(monthly)]).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  expect(
    ["2026-03-22", "2026-03-29", "2026-10-18", "2026-10-25"].map((date) =>
      occurrenceTimes(event, date).startsAt.toISOString().slice(11, 16),
    ),
  ).toEqual(["09:00", "08:00", "08:00", "09:00"]);
  const biweekly = eventSeriesSchema.parse({
    event: eventAt("2026-03-25"),
    rule: { frequency: "weekly", interval: 2, weekdays: [1, 3] },
    end: { kind: "count", count: 3 },
  });
  expect([...seriesDates(biweekly)]).toEqual(["2026-03-25", "2026-04-06", "2026-04-08"]);
});

it("rolls back only dates rejected by either EXCLUDE constraint and exports the others", async () => {
  const occupied = eventAt("2026-03-29");
  await createEventWithBooking(actor, occupied, { ...occupied, roomId });
  const allocation = eventAt("2026-04-05");
  const equipped = await createEvent(actor, allocation);
  await addAllocation(actor, equipped.id, { ...allocation, equipmentId });
  const created = await createEventSeries(
    actor,
    eventSeriesSchema.parse({
      event: eventAt("2026-03-22"),
      rule: { frequency: "weekly", interval: 1, weekdays: [7] },
      end: { kind: "count", count: 4 },
      rooms: [{ roomId }],
      equipment: [{ equipmentId }],
    }),
    now,
  );
  seriesIds.push(created.seriesId);
  expect(created.conflicts.map(({ date }) => date)).toEqual(["2026-03-29", "2026-04-05"]);
  const events = await eventsIn(created.seriesId);
  expect(events.map(({ occurrenceKey }) => occurrenceKey)).toEqual(["2026-03-22", "2026-04-12"]);
  expect((await getEventDetail(events[0].id))?.event.seriesConflictDates).toEqual([
    "2026-03-29",
    "2026-04-05",
  ]);
  const where = { eventId: { in: created.eventIds }, cancelled: false };
  expect(await db.equipmentAllocation.count({ where })).toBe(2);
  expect(await db.eventRoomBooking.count({ where: { roomId } })).toBe(3);
  const range = { from: new Date("2026-03-20"), to: new Date("2026-04-14") };
  const calendar = await getWorkspaceCalendar({ ...range, kinds: ["events"], roomId });
  expect(calendar.entries.map(({ id }) => id)).toEqual(
    expect.arrayContaining(created.eventIds.map((id) => `event:${id}`)),
  );
  expect(
    calendar.bookings.filter(({ eventId }) => created.eventIds.includes(eventId)),
  ).toHaveLength(2);
  const uids = events.map(({ uid }) => uid);
  expect(await db.calendarOutbox.count({ where: { eventUid: { in: uids }, op: "UPSERT" } })).toBe(
    2,
  );
  const feed = renderIcalFeed(
    (await loadFeedEvents(range)).filter(({ uid }) => uids.includes(uid)),
  );
  expect(feed).toContain("BEGIN:VTIMEZONE");
  expect(feed.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  const changed = await changeEventSeries(
    actor,
    created.seriesId,
    "2026-03-22",
    eventAt("2026-03-22", "12:00", "13:00"),
    now,
  );
  seriesIds.push(changed.seriesId);
  expect(changed.eventIds).toEqual(created.eventIds);
  expect((await getEventDetail(events[0].id))?.event.seriesConflictDates).toEqual([
    "2026-03-29",
    "2026-04-05",
  ]);
});

it("moves one booking, keeps the detached exception through a split, and stops following dates", async () => {
  const created = await createEventSeries(
    actor,
    eventSeriesSchema.parse({
      event: eventAt("2026-09-01"),
      rule: { frequency: "daily" },
      end: { kind: "count", count: 5 },
      rooms: [{ roomId }],
    }),
    now,
  );
  seriesIds.push(created.seriesId);
  const [first, second, third, fourth, fifth] = await eventsIn(created.seriesId);
  const windows = await Promise.all([
    db.serviceWindow.create({
      data: {
        eventId: second.id,
        kind: "STANDBY",
        startsAt: second.startsAt,
        endsAt: second.endsAt,
      },
    }),
    db.serviceWindow.create({
      data: {
        eventId: second.id,
        kind: "SETUP",
        startsAt: new Date("2026-09-02T07:30:00Z"),
        endsAt: second.startsAt,
      },
    }),
    db.serviceWindow.create({
      data: { eventId: third.id, kind: "STANDBY", startsAt: third.startsAt, endsAt: third.endsAt },
    }),
  ]);
  await updateEvent(actor, fourth.id, eventAt("2026-09-04", "11:00", "12:00"));
  const occupied = eventAt("2026-09-03", "12:00", "13:00");
  await createEventWithBooking(actor, occupied, { ...occupied, roomId });
  const split = await changeEventSeries(
    actor,
    created.seriesId,
    second.occurrenceKey!,
    eventAt("2026-09-02", "12:00", "14:00"),
    now,
  );
  seriesIds.push(split.seriesId);
  expect(split.eventIds).toEqual([second.id, fifth.id]);
  expect(split.conflicts.map(({ date }) => date)).toEqual([third.occurrenceKey]);
  const [standby, setup, blocked] = await Promise.all(
    windows.map(({ id }) => db.serviceWindow.findUniqueOrThrow({ where: { id } })),
  );
  expect([standby.startsAt, standby.endsAt]).toEqual([
    new Date("2026-09-02T10:00:00Z"),
    new Date("2026-09-02T12:00:00Z"),
  ]);
  expect([setup.startsAt, setup.endsAt]).toEqual([
    new Date("2026-09-02T09:30:00Z"),
    new Date("2026-09-02T10:00:00Z"),
  ]);
  expect(blocked).toEqual(windows[2]);
  expect(await db.event.findUnique({ where: { id: first.id } })).toEqual(first);
  expect(await db.event.findUnique({ where: { id: fourth.id } })).toMatchObject({ seriesId: null });
  expect(
    await db.eventRoomBooking.findFirst({ where: { eventId: fourth.id, cancelled: false } }),
  ).toMatchObject({
    startsAt: new Date("2026-09-04T09:00:00Z"),
  });
  expect((await eventsIn(split.seriesId)).map(({ startsAt }) => startsAt.toISOString())).toEqual([
    "2026-09-02T10:00:00.000Z",
    "2026-09-05T10:00:00.000Z",
  ]);
  const cancelled = await changeEventSeries(actor, split.seriesId, fifth.occurrenceKey!, null, now);
  expect(cancelled.cancelledIds).toEqual([fifth.id]);
  expect(await db.eventRoomBooking.count({ where: { eventId: fifth.id, cancelled: false } })).toBe(
    0,
  );
  expect(await extendEventSeries(split.seriesId, new Date("2027-03-01"))).toBeUndefined();
  const earlier = await changeEventSeries(
    actor,
    created.seriesId,
    "2026-09-01",
    eventAt("2026-09-01", "15:00", "16:00"),
    now,
  );
  seriesIds.push(earlier.seriesId);
  expect(earlier.eventIds).toEqual([first.id]);
  expect(await extendEventSeries(earlier.seriesId, new Date("2027-03-01"))).toBeUndefined();
});

it("extends the horizon once under concurrent attempts", async () => {
  const created = await createEventSeries(
    actor,
    eventSeriesSchema.parse({
      event: eventAt("2027-01-04"),
      rule: { frequency: "daily" },
      end: { kind: "count", count: 3 },
    }),
    now,
  );
  seriesIds.push(created.seriesId);
  expect(created.eventIds).toEqual([]);
  const tomorrow = new Date("2026-01-03T12:00:00Z");
  await Promise.all([
    extendEventSeries(created.seriesId, tomorrow),
    extendEventSeries(created.seriesId, tomorrow),
  ]);
  expect((await eventsIn(created.seriesId)).map(({ occurrenceKey }) => occurrenceKey)).toEqual([
    "2027-01-04",
  ]);
  await extendEventSeries(created.seriesId, new Date("2026-01-05T12:00:00Z"));
  expect(await eventsIn(created.seriesId)).toHaveLength(3);
});

it("records dates blocked by equipment health and resumes after it recovers", async () => {
  const created = await createEventSeries(
    actor,
    eventSeriesSchema.parse({
      event: eventAt("2027-01-03"),
      rule: { frequency: "daily" },
      end: { kind: "count", count: 3 },
      equipment: [{ equipmentId }],
    }),
    now,
  );
  seriesIds.push(created.seriesId);
  expect(created.eventIds).toHaveLength(1);
  await db.equipment.update({ where: { id: equipmentId }, data: { status: "RETIRED" } });
  try {
    const blocked = await extendEventSeries(created.seriesId, new Date("2026-01-03T12:00:00Z"));
    expect(blocked?.conflicts.map(({ date }) => date)).toEqual(["2027-01-04"]);
  } finally {
    await db.equipment.update({ where: { id: equipmentId }, data: { status: "OPERATIONAL" } });
  }
  await extendEventSeries(created.seriesId, new Date("2026-01-04T12:00:00Z"));
  expect((await eventsIn(created.seriesId)).map(({ occurrenceKey }) => occurrenceKey)).toEqual([
    "2027-01-03",
    "2027-01-05",
  ]);
  expect((await getEventDetail(created.eventIds[0]))?.event.seriesConflictDates).toEqual([
    "2027-01-04",
  ]);
});
