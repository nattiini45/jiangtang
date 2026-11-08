import { describe, expect, it } from "vitest";
import {
  calendarDays,
  calendarEventSegments,
  calendarHourGrid,
  calendarRange,
  dayHours,
  eventsOnDay,
  parseCalendarDate,
  shiftCalendarDate,
} from "~/lib/event-calendar";
import { dayIndexToDateKey } from "~/lib/berlin-days";
import { formatDateWith, formatTime } from "~/i18n/format";

describe("calendar Berlin ranges", () => {
  it.each([
    ["2026-03-29", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z", 23],
    ["2026-10-25", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", 25],
  ])("keeps the complete %s transition day", (date, from, to, hours) => {
    const day = parseCalendarDate(date);
    const range = calendarRange(day, "day");
    expect(range.from.toISOString()).toBe(from);
    expect(range.to.toISOString()).toBe(to);
    expect(dayHours(day)).toHaveLength(hours);
    expect(eventsOnDay([{ startsAt: range.from, endsAt: range.to }], day)).toHaveLength(1);
    expect(
      eventsOnDay([{ startsAt: new Date(+range.from - 3600000), endsAt: range.from }], day),
    ).toHaveLength(0);
    expect(
      eventsOnDay([{ startsAt: range.to, endsAt: new Date(+range.to + 3600000) }], day),
    ).toHaveLength(0);
  });

  it.each(["2026-03-29", "2026-10-25"])("starts %s's week on Monday across DST", (date) => {
    const range = calendarRange(parseCalendarDate(date), "week");
    expect(range.endDay - range.startDay).toBe(7);
    expect(dayIndexToDateKey(range.startDay)).toBe(
      date === "2026-03-29" ? "2026-03-23" : "2026-10-19",
    );
  });

  it("rejects impossible dates and navigates month/year boundaries", () => {
    const now = new Date("2026-11-08T23:30:00Z");
    expect(dayIndexToDateKey(parseCalendarDate("2026-02-30", now))).toBe("2026-11-09");
    expect(dayIndexToDateKey(shiftCalendarDate(parseCalendarDate("2026-12-31"), "month", 1))).toBe(
      "2027-01-01",
    );
    const range = calendarRange(parseCalendarDate("2026-03-29"), "month");
    expect(dayIndexToDateKey(range.startDay)).toBe("2026-02-23");
    expect(dayIndexToDateKey(range.endDay)).toBe("2026-04-06");
  });
});

function weekGrid(date: string) {
  const range = calendarRange(parseCalendarDate(date), "week");
  return calendarHourGrid(calendarDays(range.startDay, range.endDay));
}

describe("calendar shared wall-hour grid", () => {
  it("aligns an ordinary week on 24 shared hour rows", () => {
    const grid = weekGrid("2026-02-04");
    expect(grid.rows).toHaveLength(24);
    expect(grid.columns).toHaveLength(7);
    expect(grid.rows.every((row) => !row.repeated)).toBe(true);
    expect(grid.rows.map(({ instant }) => formatTime("de", instant))).toEqual(
      Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`),
    );
    for (const column of grid.columns) {
      expect(column.map(({ row }) => row)).toEqual(Array.from({ length: 24 }, (_, row) => row));
      for (const { instant, row } of column) {
        expect(formatTime("de", instant)).toBe(formatTime("de", grid.rows[row].instant));
      }
    }
  });

  it("leaves the spring transition's missing 02:00 row empty while aligning 03:00", () => {
    const grid = weekGrid("2026-03-29");
    expect(grid.rows).toHaveLength(24);
    expect(grid.rows.every((row) => !row.repeated)).toBe(true);
    expect(grid.columns[6]).toHaveLength(23);
    expect(grid.columns[6].map(({ row }) => row)).toEqual([
      0,
      1,
      ...Array.from({ length: 21 }, (_, index) => index + 3),
    ]);
    for (const column of grid.columns) {
      const three = column.find(({ instant }) => formatTime("de", instant) === "03:00");
      expect(three?.row).toBe(3);
    }
    expect(grid.columns[0].some(({ row }) => row === 2)).toBe(true);
  });

  it("reserves a second autumn 02:00 row only for the transition day", () => {
    const grid = weekGrid("2026-10-25");
    expect(grid.rows).toHaveLength(25);
    expect(grid.columns[6]).toHaveLength(25);
    expect(grid.columns[6].map(({ row }) => row)).toEqual(
      Array.from({ length: 25 }, (_, row) => row),
    );
    for (const column of grid.columns.slice(0, 6)) {
      expect(column).toHaveLength(24);
      expect(column.map(({ row }) => row)).toEqual([
        0,
        1,
        2,
        ...Array.from({ length: 21 }, (_, index) => index + 4),
      ]);
    }
    for (const column of grid.columns) {
      const three = column.find(({ instant }) => formatTime("de", instant) === "03:00");
      expect(three?.row).toBe(4);
    }
    expect(grid.rows.filter(({ repeated }) => repeated)).toEqual([
      { instant: Date.parse("2026-10-25T00:00:00Z"), repeated: true },
      { instant: Date.parse("2026-10-25T01:00:00Z"), repeated: true },
    ]);
    const zones = grid.rows
      .filter(({ repeated }) => repeated)
      .map(({ instant }) =>
        formatDateWith("de", instant, {
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZoneName: "short",
        }),
      );
    expect(zones).toEqual(["02:00 MESZ", "02:00 MEZ"]);
  });

  it("keeps transition representatives even when a normal day comes afterward", () => {
    const transition = parseCalendarDate("2026-10-25");
    const grid = calendarHourGrid([transition, transition + 1]);
    expect(grid.rows[2]).toEqual({ instant: Date.parse("2026-10-25T00:00:00Z"), repeated: true });
    expect(grid.rows[3]).toEqual({ instant: Date.parse("2026-10-25T01:00:00Z"), repeated: true });
  });

  it.each([
    ["2026-03-29", 23],
    ["2026-10-25", 25],
  ])("keeps a standalone %s transition day on its natural %i rows", (date, count) => {
    const grid = calendarHourGrid([parseCalendarDate(date)]);
    expect(grid.rows).toHaveLength(count);
    expect(grid.columns[0].map(({ row }) => row)).toEqual(
      Array.from({ length: count }, (_, row) => row),
    );
    expect(grid.rows.map(({ instant }) => instant)).toEqual(dayHours(parseCalendarDate(date)));
  });

  it("returns no rows or columns for no days", () => {
    expect(calendarHourGrid([])).toEqual({ rows: [], columns: [] });
  });
});

describe("calendar event segments", () => {
  const HOUR = 3_600_000;

  it("merges contiguous ordinary hours and clips fractional event edges", () => {
    const slots = calendarHourGrid([parseCalendarDate("2026-02-04")]).columns[0];
    const startsAt = slots[9].instant + HOUR / 4;
    const endsAt = slots[11].instant + HOUR / 2;
    expect(calendarEventSegments(startsAt, endsAt, slots)).toEqual([
      { top: 9.25, bottom: 11.5, startsAt, endsAt },
    ]);
  });

  it("splits spring events across the missing shared 02:00 row", () => {
    const slots = weekGrid("2026-03-29").columns[6];
    const startsAt = slots[1].instant + HOUR / 2;
    const endsAt = slots[2].instant + HOUR / 2;
    expect(calendarEventSegments(startsAt, endsAt, slots)).toEqual([
      { top: 1.5, bottom: 2, startsAt, endsAt: slots[2].instant },
      { top: 3, bottom: 3.5, startsAt: slots[2].instant, endsAt },
    ]);
    expect(calendarEventSegments(startsAt, slots[2].instant, slots)).toEqual([
      { top: 1.5, bottom: 2, startsAt, endsAt: slots[2].instant },
    ]);
  });

  it("splits normal autumn-week days across the second 02:00 placeholder", () => {
    const slots = weekGrid("2026-10-25").columns[0];
    const startsAt = slots[2].instant + HOUR / 2;
    const endsAt = slots[3].instant + HOUR / 2;
    expect(calendarEventSegments(startsAt, endsAt, slots)).toEqual([
      { top: 2.5, bottom: 3, startsAt, endsAt: slots[3].instant },
      { top: 4, bottom: 4.5, startsAt: slots[3].instant, endsAt },
    ]);
    expect(calendarEventSegments(startsAt, slots[3].instant, slots)).toEqual([
      { top: 2.5, bottom: 3, startsAt, endsAt: slots[3].instant },
    ]);
  });

  it("merges both repeated autumn hours when their instants and rows are contiguous", () => {
    const slots = weekGrid("2026-10-25").columns[6];
    const startsAt = slots[2].instant + HOUR / 2;
    const endsAt = slots[3].instant + HOUR / 2;
    expect(calendarEventSegments(startsAt, endsAt, slots)).toEqual([
      { top: 2.5, bottom: 3.5, startsAt, endsAt },
    ]);
  });

  it("does not merge adjacent visual rows whose instants have a gap", () => {
    const instant = Date.parse("2026-02-04T08:00:00Z");
    expect(
      calendarEventSegments(instant, instant + 3 * HOUR, [
        { instant, row: 0 },
        { instant: instant + 2 * HOUR, row: 1 },
      ]),
    ).toEqual([
      { top: 0, bottom: 1, startsAt: instant, endsAt: instant + HOUR },
      { top: 1, bottom: 2, startsAt: instant + 2 * HOUR, endsAt: instant + 3 * HOUR },
    ]);
  });

  it.each(["2026-02-04", "2026-03-29", "2026-10-25"])(
    "clips a multi-day event to the entire standalone %s day",
    (date) => {
      const slots = calendarHourGrid([parseCalendarDate(date)]).columns[0];
      const startsAt = slots[0].instant;
      const endsAt = slots.at(-1)!.instant + HOUR;
      expect(calendarEventSegments(startsAt - HOUR, endsAt + HOUR, slots)).toEqual([
        { top: 0, bottom: slots.length, startsAt, endsAt },
      ]);
      expect(calendarEventSegments(startsAt - HOUR, startsAt, slots)).toEqual([]);
      expect(calendarEventSegments(endsAt, endsAt + HOUR, slots)).toEqual([]);
      expect(calendarEventSegments(startsAt, startsAt, slots)).toEqual([]);
      expect(calendarEventSegments(endsAt, startsAt, slots)).toEqual([]);
    },
  );

  it("returns no segments when the column has no slots", () => {
    expect(calendarEventSegments(0, HOUR, [])).toEqual([]);
  });
});
