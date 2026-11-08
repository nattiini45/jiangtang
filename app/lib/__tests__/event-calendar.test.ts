import { describe, expect, it } from "vitest";
import {
  calendarRange,
  dayHours,
  eventsOnDay,
  parseCalendarDate,
  shiftCalendarDate,
} from "~/lib/event-calendar";
import { dayIndexToDateKey } from "~/lib/berlin-days";

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
