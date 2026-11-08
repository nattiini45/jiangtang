import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { loadFeedEvents, renderIcalFeed } from "~/lib/calendar/ical.server";
import { tokenMatches } from "~/lib/calendar/ical-token.server";

/**
 * iCal feed. Exercises the pure renderer
 * (no DB) plus the DB-backed loader. The renderer asserts are the
 * validation criteria: one VEVENT per event, UID/SEQUENCE correct, cancelled
 * events carry STATUS:CANCELLED, VTIMEZONE present, DST-correct offsets.
 */

const createdEventIds: string[] = [];
const createdOutboxIds: string[] = [];

beforeAll(async () => {
  // Seed two events: one normal, one cancelled. Each with an outbox row so the
  // SEQUENCE field is exercised.
  const e1 = await db.event.create({
    data: {
      title: "Sommerfest",
      startsAt: new Date("2026-07-15T10:00:00Z"),
      endsAt: new Date("2026-07-15T14:00:00Z"),
      status: "CONFIRMED",
      uid: "evt-summer-001",
    },
  });
  const e2 = await db.event.create({
    data: {
      title: "Abgesagtes Event",
      startsAt: new Date("2026-12-01T09:00:00Z"),
      endsAt: new Date("2026-12-01T11:00:00Z"),
      status: "CANCELLED",
      uid: "evt-cancelled-002",
    },
  });
  createdEventIds.push(e1.id, e2.id);

  // Outbox rows give each event a SEQUENCE (e1 at 2, e2 at 0).
  for (const row of [
    { eventUid: "evt-summer-001", sequence: 0, payload: {}, op: "UPSERT" as const },
    { eventUid: "evt-summer-001", sequence: 1, payload: {}, op: "UPSERT" as const },
    { eventUid: "evt-summer-001", sequence: 2, payload: {}, op: "UPSERT" as const },
    { eventUid: "evt-cancelled-002", sequence: 0, payload: {}, op: "UPSERT" as const },
  ]) {
    const o = await db.calendarOutbox.create({ data: { ...row, status: "PENDING" } });
    createdOutboxIds.push(o.id);
  }
});

afterAll(async () => {
  // CalendarOutbox has no FK to Event, but delete it first anyway for symmetry;
  // no EventRoomBooking/EquipmentAllocation/ServiceWindow rows were created here,
  // so the Event deletes need no other child cleanup.
  await db.calendarOutbox.deleteMany({ where: { id: { in: createdOutboxIds } } });
  await db.event.deleteMany({ where: { id: { in: createdEventIds } } });
  await db.$disconnect();
});

describe("feed name follows DEFAULT_LOCALE", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["en", "Jiangtang · AV events"],
    ["de", "Jiangtang · AV-Veranstaltungen"],
  ])("%s names the calendar and keeps the Berlin VTIMEZONE", (locale, name) => {
    vi.stubEnv("DEFAULT_LOCALE", locale);
    const body = renderIcalFeed([]);
    expect(body).toContain(`X-WR-CALNAME:${name}`);
    expect(body).toContain(`NAME:${name}`);
    expect(body).toContain("BEGIN:VTIMEZONE");
    expect(body).toContain("TZID:Europe/Berlin");
  });
});

describe("renderIcalFeed (pure)", () => {
  it("emits a well-formed VCALENDAR with a VTIMEZONE for Europe/Berlin", () => {
    const body = renderIcalFeed([]);
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("END:VCALENDAR");
    expect(body).toContain("BEGIN:VTIMEZONE");
    expect(body).toContain("TZID:Europe/Berlin");
    expect(body).toContain("BEGIN:STANDARD");
    expect(body).toContain("BEGIN:DAYLIGHT");
    // DST transition rules present
    expect(body).toContain("BYMONTH=3");
    expect(body).toContain("BYMONTH=10");
  });

  it("emits one VEVENT per event with correct UID + SEQUENCE", () => {
    const body = renderIcalFeed([
      {
        uid: "u1",
        title: "A",
        description: null,
        startsAt: new Date("2026-07-15T10:00:00Z"),
        endsAt: new Date("2026-07-15T12:00:00Z"),
        location: "Raum 32",
        sequence: 3,
        cancelled: false,
      },
      {
        uid: "u2",
        title: "B",
        description: null,
        startsAt: new Date("2026-07-16T10:00:00Z"),
        endsAt: new Date("2026-07-16T12:00:00Z"),
        location: null,
        sequence: 0,
        cancelled: false,
      },
    ]);
    expect(body).toContain("UID:u1");
    expect(body).toContain("SEQUENCE:3");
    expect(body).toContain("UID:u2");
    expect(body).toContain("LOCATION:Raum 32");
    // count VEVENTs
    expect(body.match(/BEGIN:VEVENT/g)?.length).toBe(2);
  });

  it("marks a cancelled event with STATUS:CANCELLED (so subscribers see the cancel)", () => {
    const body = renderIcalFeed([
      {
        uid: "u-c",
        title: "C",
        description: null,
        startsAt: new Date("2026-08-01T10:00:00Z"),
        endsAt: new Date("2026-08-01T12:00:00Z"),
        location: null,
        sequence: 1,
        cancelled: true,
      },
    ]);
    expect(body).toContain("STATUS:CANCELLED");
  });

  it("uses Berlin TZID offsets correct across a summer→winter DST boundary", () => {
    // Summer event (CEST, UTC+2): 10:00Z = 12:00 Berlin.
    const summer = renderIcalFeed([
      {
        uid: "s",
        title: "S",
        description: null,
        startsAt: new Date("2026-07-15T10:00:00Z"),
        endsAt: new Date("2026-07-15T12:00:00Z"),
        location: null,
        sequence: 0,
        cancelled: false,
      },
    ]);
    expect(summer).toContain("DTSTART;TZID=Europe/Berlin:20260715T120000");
    // Winter event (CET, UTC+1): 09:00Z = 10:00 Berlin.
    const winter = renderIcalFeed([
      {
        uid: "w",
        title: "W",
        description: null,
        startsAt: new Date("2026-12-01T09:00:00Z"),
        endsAt: new Date("2026-12-01T11:00:00Z"),
        location: null,
        sequence: 0,
        cancelled: false,
      },
    ]);
    expect(winter).toContain("DTSTART;TZID=Europe/Berlin:20261201T100000");
  });
});

describe("renderIcalFeed does not depend on the process time zone", () => {
  const savedTz = process.env.TZ;
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  const event = (startsAt: string, endsAt: string) => ({
    uid: "tz",
    title: "TZ",
    description: null,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    location: null,
    sequence: 0,
    cancelled: false,
  });
  const timeLines = (body: string) =>
    body.split("\r\n").filter((l) => /^DT(START|END);TZID=/.test(l));

  it.each(["UTC", "America/New_York", "Asia/Tokyo", "Europe/Berlin"])(
    "renders Berlin wall-clock times with TZ=%s",
    (tz) => {
      process.env.TZ = tz;
      // Proves the switch took effect: the process offset in July differs per zone.
      const julyOffset = new Date("2026-07-15T10:00:00Z").getTimezoneOffset();
      expect(julyOffset).toBe(
        { UTC: 0, "America/New_York": 240, "Asia/Tokyo": -540, "Europe/Berlin": -120 }[tz],
      );

      expect(
        timeLines(renderIcalFeed([event("2026-07-15T10:00:00Z", "2026-07-15T12:00:00Z")])),
      ).toEqual([
        "DTSTART;TZID=Europe/Berlin:20260715T120000",
        "DTEND;TZID=Europe/Berlin:20260715T140000",
      ]);
      expect(
        timeLines(renderIcalFeed([event("2026-12-01T09:00:00Z", "2026-12-01T11:00:00Z")])),
      ).toEqual([
        "DTSTART;TZID=Europe/Berlin:20261201T100000",
        "DTEND;TZID=Europe/Berlin:20261201T120000",
      ]);
      // Across the autumn change: 23:30Z = 01:30 CEST, 02:30Z = 03:30 CET.
      expect(
        timeLines(renderIcalFeed([event("2026-10-24T23:30:00Z", "2026-10-25T02:30:00Z")])),
      ).toEqual([
        "DTSTART;TZID=Europe/Berlin:20261025T013000",
        "DTEND;TZID=Europe/Berlin:20261025T033000",
      ]);
    },
  );
});

describe("loadFeedEvents (DB-backed)", () => {
  it("loads events with the latest outbox SEQUENCE per uid", async () => {
    const events = await loadFeedEvents({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
    const summer = events.find((e) => e.uid === "evt-summer-001");
    const cancelled = events.find((e) => e.uid === "evt-cancelled-002");
    expect(summer?.sequence).toBe(2); // three outbox rows → max sequence 2
    expect(summer?.cancelled).toBe(false);
    expect(cancelled?.cancelled).toBe(true);
    expect(cancelled?.sequence).toBe(0);
  });

  it("renders the seeded events into a valid feed", async () => {
    const events = await loadFeedEvents({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
    const body = renderIcalFeed(events);
    expect(body).toContain("UID:evt-summer-001");
    expect(body).toContain("UID:evt-cancelled-002");
    expect(body).toContain("STATUS:CANCELLED");
    expect(body).toContain("SEQUENCE:2");
  });
});

describe("feed token gate", () => {
  it("compares tokens in constant time and rejects mismatches", () => {
    const expected = "a-long-random-feed-token-1234567890";
    expect(tokenMatches(expected, expected)).toBe(true);
    expect(tokenMatches(expected, "wrong")).toBe(false);
    expect(tokenMatches(expected, "")).toBe(false);
    // same length, different content
    expect(tokenMatches(expected, "b-long-random-feed-token-1234567890")).toBe(false);
  });
});
