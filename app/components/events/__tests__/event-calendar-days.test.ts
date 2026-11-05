import { afterEach, describe, expect, it } from "vitest";
import {
  bucketEventsByBerlinDay,
  buildMonthCells,
  currentBerlinMonth,
  parseCalendarMonth,
  shiftCalendarMonth,
} from "../event-calendar-days";

const ev = (id: string, startsAt: string, endsAt: string) => ({
  id,
  startsAt: new Date(startsAt),
  endsAt: new Date(endsAt),
});

const MARCH = { year: 2027, month: 2 };
const OCTOBER = { year: 2027, month: 9 };
const NOVEMBER = { year: 2027, month: 10 };

function keysOf(events: ReturnType<typeof ev>[], m: { year: number; month: number }) {
  return [...bucketEventsByBerlinDay(events, m.year, m.month).keys()].sort();
}

describe("bucketEventsByBerlinDay", () => {
  it("covers exactly the 27th and 28th across the spring-forward change", () => {
    // 23:30 CET on the 27th until 12:00 CEST on the 28th. Stepping the instant
    // by 24 h used to jump from the 27th to the 29th and never reach the end.
    const e = ev("a", "2027-03-27T22:30:00Z", "2027-03-28T10:00:00Z");
    expect(keysOf([e], MARCH)).toEqual(["2027-03-27", "2027-03-28"]);
  });

  it("keeps a spring-forward event that ends at Berlin midnight on the 28th only", () => {
    const e = ev("a", "2027-03-27T12:00:00Z", "2027-03-28T22:00:00Z"); // 00:00 CEST on the 29th
    expect(keysOf([e], MARCH)).toEqual(["2027-03-27", "2027-03-28"]);
  });

  it("covers every day across the autumn fall-back, split over month boundaries", () => {
    // 23:30 CEST on 30 Oct until 10:00 CET on 1 Nov.
    const e = ev("a", "2027-10-30T21:30:00Z", "2027-11-01T09:00:00Z");
    expect(keysOf([e], OCTOBER)).toEqual(["2027-10-30", "2027-10-31"]);
    expect(keysOf([e], NOVEMBER)).toEqual(["2027-11-01"]);
  });

  it("does not show an event that ends exactly at Berlin midnight on the next day", () => {
    const e = ev("a", "2027-10-31T08:00:00Z", "2027-10-31T23:00:00Z"); // ends 00:00 CET on 1 Nov
    expect(keysOf([e], OCTOBER)).toEqual(["2027-10-31"]);
    expect(keysOf([e], NOVEMBER)).toEqual([]);
  });

  it("shows an event that starts exactly at Berlin midnight on that day", () => {
    const e = ev("a", "2027-02-28T23:00:00Z", "2027-03-01T10:00:00Z"); // starts 00:00 CET on 1 Mar
    expect(keysOf([e], MARCH)).toEqual(["2027-03-01"]);
  });

  it("puts a row with endsAt <= startsAt on its start day only", () => {
    const equal = ev("eq", "2027-03-10T09:00:00Z", "2027-03-10T09:00:00Z");
    const inverted = ev("inv", "2027-03-10T09:00:00Z", "2027-03-05T09:00:00Z");
    const buckets = bucketEventsByBerlinDay([equal, inverted], MARCH.year, MARCH.month);
    expect([...buckets.keys()]).toEqual(["2027-03-10"]);
    expect(buckets.get("2027-03-10")?.map((x) => x.id)).toEqual(["eq", "inv"]);
  });

  it("buckets a multi-year event onto the visible days only", () => {
    const e = ev("a", "1900-01-01T00:00:00Z", "9000-01-01T00:00:00Z");
    const buckets = bucketEventsByBerlinDay([e], MARCH.year, MARCH.month);
    expect(buckets.size).toBe(31);
    for (const list of buckets.values()) expect(list).toEqual([e]);
    expect([...buckets.keys()].sort()[0]).toBe("2027-03-01");
    expect([...buckets.keys()].sort()[30]).toBe("2027-03-31");
  });

  it("clips an event that starts before the month and ends inside it", () => {
    const e = ev("a", "2027-02-26T10:00:00Z", "2027-03-03T10:00:00Z");
    expect(keysOf([e], MARCH)).toEqual(["2027-03-01", "2027-03-02", "2027-03-03"]);
  });

  it("ignores events wholly outside the month", () => {
    const before = ev("b", "2027-02-10T10:00:00Z", "2027-02-12T10:00:00Z");
    const after = ev("c", "2027-04-10T10:00:00Z", "2027-04-12T10:00:00Z");
    // Ends exactly at Berlin midnight starting March: no occupied instant in March.
    const touching = ev("d", "2027-02-27T10:00:00Z", "2027-02-28T23:00:00Z");
    expect(bucketEventsByBerlinDay([before, after, touching], MARCH.year, MARCH.month).size).toBe(
      0,
    );
  });

  it("skips rows whose dates cannot be parsed", () => {
    const bad = ev("bad", "not a date", "2027-03-10T10:00:00Z");
    expect(bucketEventsByBerlinDay([bad], MARCH.year, MARCH.month).size).toBe(0);
  });

  it("accepts serialized dates", () => {
    const e = { startsAt: "2027-03-27T22:30:00Z", endsAt: "2027-03-28T10:00:00Z" };
    expect([...bucketEventsByBerlinDay([e], MARCH.year, MARCH.month).keys()]).toEqual([
      "2027-03-27",
      "2027-03-28",
    ]);
  });
});

describe("buildMonthCells", () => {
  it("lays out March 2027 (starts on a Monday) as five full weeks", () => {
    const cells = buildMonthCells(2027, 2);
    expect(cells).toHaveLength(35);
    expect(cells[0]).toEqual({ day: 1, date: "2027-03-01" });
    expect(cells[30]).toEqual({ day: 31, date: "2027-03-31" });
    expect(cells[31]).toEqual({ day: null, date: null });
  });

  it("pads the lead for a month starting on a Friday and handles December", () => {
    const oct = buildMonthCells(2027, 9);
    expect(oct.slice(0, 4).every((c) => c.date === null)).toBe(true);
    expect(oct[4]).toEqual({ day: 1, date: "2027-10-01" });
    const dec = buildMonthCells(2027, 11);
    expect(dec.filter((c) => c.date).at(-1)).toEqual({ day: 31, date: "2027-12-31" });
    expect(dec.length % 7).toBe(0);
  });

  it("gives February 28 days, and 29 in a leap year", () => {
    const feb2027 = buildMonthCells(2027, 1).filter((c) => c.date);
    expect(feb2027).toHaveLength(28);
    expect(feb2027.at(-1)).toEqual({ day: 28, date: "2027-02-28" });

    // 1 February 2028 is a Tuesday: one padding cell before it.
    const feb2028 = buildMonthCells(2028, 1);
    expect(feb2028[0]).toEqual({ day: null, date: null });
    expect(feb2028[1]).toEqual({ day: 1, date: "2028-02-01" });
    expect(feb2028.filter((c) => c.date)).toHaveLength(29);
    expect(feb2028.filter((c) => c.date).at(-1)).toEqual({ day: 29, date: "2028-02-29" });
  });

  it("buckets an event across a leap day onto both February days and March", () => {
    // 28 Feb 2028 10:00 to 1 Mar 2028 10:00 Berlin (CET, UTC+1).
    const across = ev("leap", "2028-02-28T09:00:00Z", "2028-03-01T09:00:00Z");
    expect(keysOf([across], { year: 2028, month: 1 })).toEqual(["2028-02-28", "2028-02-29"]);
    expect(keysOf([across], { year: 2028, month: 2 })).toEqual(["2028-03-01"]);
  });

  describe("on a host east of Berlin", () => {
    const original = process.env.TZ;
    afterEach(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    it("keys every cell by its own Berlin date", () => {
      process.env.TZ = "Asia/Tokyo";
      // Sanity: machine-local midnight really is the previous Berlin day here.
      expect(new Date(2027, 2, 1).toISOString()).toBe("2027-02-28T15:00:00.000Z");

      const cells = buildMonthCells(2027, 2);
      const dated = cells.filter((c) => c.date);
      expect(dated.map((c) => c.date)).toEqual(
        Array.from({ length: 31 }, (_, i) => `2027-03-${String(i + 1).padStart(2, "0")}`),
      );
      expect(cells[0].date).toBe("2027-03-01");
    });

    it("derives the default month and the month shift from the Berlin calendar", () => {
      process.env.TZ = "Asia/Tokyo";
      // 22:00 in Berlin on 31 March is already 1 April in Tokyo.
      const now = new Date("2027-03-31T20:00:00Z");
      expect(currentBerlinMonth(now)).toEqual({ year: 2027, month: 2 });
      expect(parseCalendarMonth(null, now)).toEqual({ year: 2027, month: 2 });
      expect(shiftCalendarMonth(2027, 2, 1)).toBe("2027-04");
    });

    it("buckets events onto the same keys as in Berlin", () => {
      process.env.TZ = "Asia/Tokyo";
      const e = ev("a", "2027-03-27T22:30:00Z", "2027-03-28T10:00:00Z");
      expect(keysOf([e], MARCH)).toEqual(["2027-03-27", "2027-03-28"]);
    });
  });
});

describe("parseCalendarMonth / shiftCalendarMonth", () => {
  const now = new Date("2027-06-15T10:00:00Z");

  it("parses YYYY-MM and falls back to the current Berlin month", () => {
    expect(parseCalendarMonth("2027-03", now)).toEqual({ year: 2027, month: 2 });
    expect(parseCalendarMonth("2027-13", now)).toEqual({ year: 2027, month: 5 });
    expect(parseCalendarMonth("2027-00", now)).toEqual({ year: 2027, month: 5 });
    expect(parseCalendarMonth("garbage", now)).toEqual({ year: 2027, month: 5 });
    expect(parseCalendarMonth(undefined, now)).toEqual({ year: 2027, month: 5 });
  });

  it("uses the Berlin month when the instant is just past a UTC month change", () => {
    expect(currentBerlinMonth(new Date("2027-05-31T22:30:00Z"))).toEqual({ year: 2027, month: 5 });
  });

  it("shifts across year boundaries", () => {
    expect(shiftCalendarMonth(2027, 0, -1)).toBe("2026-12");
    expect(shiftCalendarMonth(2027, 11, 1)).toBe("2028-01");
    expect(shiftCalendarMonth(2027, 5, 1)).toBe("2027-07");
  });
});
