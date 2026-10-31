import { describe, expect, it } from "vitest";
import { formatHM, splitByBerlinDays, unionMinutes } from "../time-utils";
import { berlinLocalToUtc } from "~/lib/time.server";
import { dayIndexToDateKey, isoWeekRange } from "~/lib/berlin-days";

const B = berlinLocalToUtc;

describe("splitByBerlinDays", () => {
  it("keeps a same-day entry in one piece", () => {
    const pieces = splitByBerlinDays(B("2026-10-08T09:00"), B("2026-10-08T11:30"));
    expect(pieces).toHaveLength(1);
    expect(pieces[0].dateKey).toBe("2026-10-08");
    expect(pieces[0].minutes).toBe(150);
  });

  it("splits an entry crossing Berlin midnight at the midnight", () => {
    const pieces = splitByBerlinDays(B("2026-10-08T22:00"), B("2026-10-09T02:00"));
    expect(pieces.map((p) => [p.dateKey, p.minutes])).toEqual([
      ["2026-10-08", 120],
      ["2026-10-09", 120],
    ]);
  });

  it("2026-10-25 is a 25-hour day — the transition day carries the extra hour", () => {
    // 22:00 → next day 04:00 across the CEST→CET fallback (03:00 happens twice).
    const pieces = splitByBerlinDays(B("2026-10-24T22:00"), B("2026-10-26T04:00"));
    const day25 = pieces.find((p) => p.dateKey === "2026-10-25")!;
    expect(day25.minutes).toBe(25 * 60);
    expect(pieces.reduce((s, p) => s + p.minutes, 0)).toBe(2 * 60 + 25 * 60 + 4 * 60);
  });

  it("2026-03-29 is a 23-hour day", () => {
    const pieces = splitByBerlinDays(B("2026-03-28T22:00"), B("2026-03-30T04:00"));
    const day29 = pieces.find((p) => p.dateKey === "2026-03-29")!;
    expect(day29.minutes).toBe(23 * 60);
    expect(pieces.reduce((s, p) => s + p.minutes, 0)).toBe(2 * 60 + 23 * 60 + 4 * 60);
  });

  it("empty or inverted intervals yield nothing", () => {
    const t0 = B("2026-10-08T09:00");
    expect(splitByBerlinDays(t0, t0)).toEqual([]);
    expect(splitByBerlinDays(B("2026-10-08T10:00"), t0)).toEqual([]);
  });
});

describe("unionMinutes", () => {
  it("merges overlapping intervals: overlap counts once", () => {
    expect(
      unionMinutes([
        { start: B("2026-10-08T10:00"), end: B("2026-10-08T12:00") },
        { start: B("2026-10-08T11:00"), end: B("2026-10-08T13:00") },
      ]),
    ).toBe(180); // 10:00–13:00, not 4 h
  });

  it("sums disjoint intervals", () => {
    expect(
      unionMinutes([
        { start: B("2026-10-08T09:00"), end: B("2026-10-08T10:00") },
        { start: B("2026-10-08T14:00"), end: B("2026-10-08T15:30") },
      ]),
    ).toBe(150);
  });

  it("handles contained intervals and unordered input", () => {
    expect(
      unionMinutes([
        { start: B("2026-10-08T14:00"), end: B("2026-10-08T15:00") },
        { start: B("2026-10-08T09:00"), end: B("2026-10-08T17:00") },
      ]),
    ).toBe(480);
  });
});

describe("formatHM / isoWeekRange", () => {
  it("formats h:mm", () => {
    expect(formatHM(0)).toBe("0:00");
    expect(formatHM(75)).toBe("1:15");
    expect(formatHM(600)).toBe("10:00");
  });

  it("isoWeekRange returns the Berlin Mon–Sun of an ISO week", () => {
    const { startDay, endDay } = isoWeekRange("2026-W41");
    expect(dayIndexToDateKey(startDay)).toBe("2026-10-05");
    expect(dayIndexToDateKey(endDay)).toBe("2026-10-11");
    expect(() => isoWeekRange("2026-41")).toThrow();
  });
});
