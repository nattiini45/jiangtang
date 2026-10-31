import {
  berlinDayIndex,
  berlinDayStartMs,
  dayIndexToDateKey,
  isoWeekRange,
} from "~/lib/berlin-days";

/**
 * Pure time-entry math. Berlin civil days are not always 24 h
 * (2026-10-25 is 25 h, 2026-03-29 is 23 h), so "minutes per day" is computed
 * by clipping each interval at the UTC instants Berlin midnights fall on —
 * never by assuming 86 400 000 ms.
 */

export { isoWeekRange };

export interface DaySplit {
  /** Berlin day index (see berlin-days.ts). */
  day: number;
  /** "YYYY-MM-DD" on the Berlin calendar. */
  dateKey: string;
  /** Whole minutes of [start, end) inside this day. */
  minutes: number;
}

/** Clip `[start, end)` into per-Berlin-day pieces. Empty/inverted → []. */
export function splitByBerlinDays(start: Date, end: Date): DaySplit[] {
  const s = start.getTime();
  const e = end.getTime();
  if (!(e > s)) return [];
  const out: DaySplit[] = [];
  for (let day = berlinDayIndex(s); ; day++) {
    const dayStart = berlinDayStartMs(day);
    const dayEnd = berlinDayStartMs(day + 1);
    const from = Math.max(s, dayStart);
    const to = Math.min(e, dayEnd);
    if (to > from) {
      out.push({ day, dateKey: dayIndexToDateKey(day), minutes: Math.round((to - from) / 60_000) });
    }
    if (e <= dayEnd) break;
  }
  return out;
}

export interface Interval {
  start: Date | number;
  end: Date | number;
}

/**
 * Minutes covered by the UNION of `intervals` — overlapping entries count once
 * (overlap is allowed at write time, so the read merges before
 * summing). Day and week totals must use this; per-task cells may show the raw
 * per-entry sum instead.
 */
export function unionMinutes(intervals: Interval[]): number {
  const sorted = intervals
    .map((i) => ({
      start: typeof i.start === "number" ? i.start : i.start.getTime(),
      end: typeof i.end === "number" ? i.end : i.end.getTime(),
    }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let curStart = Number.NEGATIVE_INFINITY;
  let curEnd = Number.NEGATIVE_INFINITY;
  for (const i of sorted) {
    if (i.start > curEnd) {
      if (Number.isFinite(curStart)) total += curEnd - curStart;
      curStart = i.start;
      curEnd = i.end;
    } else if (i.end > curEnd) {
      curEnd = i.end;
    }
  }
  if (Number.isFinite(curStart)) total += curEnd - curStart;
  return Math.round(total / 60_000);
}

/** Minutes → "h:mm" display. */
export function formatHM(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}
