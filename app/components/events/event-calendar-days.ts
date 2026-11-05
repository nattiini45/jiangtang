import {
  berlinDayIndex,
  civilFromDayIndex,
  dayIndexFromCivil,
  isoWeekday,
} from "~/lib/berlin-days";

/**
 * Pure month-grid maths for the event calendar. Client-safe and independent of
 * the process time zone: every day is a Berlin civil date handled as a day
 * index, never as an instant stepped forward in 24 h hops (a Berlin day is 23 h
 * or 25 h on the two DST changes, so an instant walk can skip or repeat a date).
 */

export interface CalendarMonth {
  year: number;
  /** 0-based, like `Date#getMonth`. */
  month: number;
}

export interface CalendarCell {
  day: number | null;
  /** Berlin "YYYY-MM-DD", or null for the padding cells around the month. */
  date: string | null;
}

export interface SpanningEvent {
  startsAt: Date | string | number;
  endsAt: Date | string | number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function dateKey(year: number, month1: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad2(month1)}-${pad2(day)}`;
}

/** The month containing `now` on the Berlin calendar. */
export function currentBerlinMonth(now: Date = new Date()): CalendarMonth {
  const { year, month } = civilFromDayIndex(berlinDayIndex(now));
  return { year, month: month - 1 };
}

/** Parse "YYYY-MM" into a month; anything else (or month 00/13+) is this Berlin month. */
export function parseCalendarMonth(
  input: string | null | undefined,
  now: Date = new Date(),
): CalendarMonth {
  const m = /^(\d{4})-(\d{2})$/.exec(input ?? "");
  if (m) {
    const month = Number(m[2]) - 1;
    if (month >= 0 && month <= 11) return { year: Number(m[1]), month };
  }
  return currentBerlinMonth(now);
}

/** "YYYY-MM" of the month `delta` months away from `year`/`month`. */
export function shiftCalendarMonth(year: number, month: number, delta: number): string {
  const total = year * 12 + month + delta;
  const y = Math.floor(total / 12);
  return `${String(y).padStart(4, "0")}-${pad2(total - y * 12 + 1)}`;
}

/** First and last Berlin day index of the month. */
function monthDayRange(year: number, month: number): { first: number; last: number } {
  const first = dayIndexFromCivil(year, month + 1, 1);
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonth1 = month === 11 ? 1 : month + 2;
  return { first, last: dayIndexFromCivil(nextYear, nextMonth1, 1) - 1 };
}

/**
 * The Monday-first grid for a month: leading padding, one cell per day keyed by
 * its Berlin date, trailing padding up to a full week.
 */
export function buildMonthCells(year: number, month: number): CalendarCell[] {
  const { first, last } = monthDayRange(year, month);
  const lead = isoWeekday(first) - 1;
  const cells: CalendarCell[] = [];
  for (let i = 0; i < lead; i++) cells.push({ day: null, date: null });
  for (let d = 1; d <= last - first + 1; d++) {
    cells.push({ day: d, date: dateKey(year, month + 1, d) });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, date: null });
  return cells;
}

/**
 * Bucket events onto the Berlin dates of `year`/`month` they occupy, half-open
 * `[startsAt, endsAt)`: an event ending exactly at Berlin midnight does not
 * reach the next day, and a row with `endsAt <= startsAt` shows on its start
 * day only. The walk is clamped to the month, so it takes at most 31 steps per
 * event however long the event is. Events with an unparseable date are skipped.
 */
export function bucketEventsByBerlinDay<T extends SpanningEvent>(
  events: readonly T[],
  year: number,
  month: number,
): Map<string, T[]> {
  const { first, last } = monthDayRange(year, month);
  const byDay = new Map<string, T[]>();
  for (const ev of events) {
    const startMs = new Date(ev.startsAt).getTime();
    const endMs = new Date(ev.endsAt).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    const startDay = berlinDayIndex(startMs);
    // The last occupied instant is endMs - 1: the interval is half-open.
    const lastDay = endMs > startMs ? berlinDayIndex(endMs - 1) : startDay;
    const from = Math.max(startDay, first);
    const to = Math.min(lastDay, last);
    for (let day = from; day <= to; day++) {
      const key = dateKey(year, month + 1, day - first + 1);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(ev);
      else byDay.set(key, [ev]);
    }
  }
  return byDay;
}
