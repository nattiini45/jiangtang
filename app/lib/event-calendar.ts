import { TZDate } from "@date-fns/tz";
import {
  BERLIN_TZ,
  berlinDayIndex,
  berlinDayStartMs,
  civilFromDayIndex,
  dayIndexFromCivil,
  dayIndexToDateKey,
  isoWeekStart,
} from "~/lib/berlin-days";

export const CALENDAR_VIEWS = ["month", "week", "day", "rooms", "list"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export function parseCalendarDate(input: string | null, now = new Date()): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input ?? "");
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    const index = dayIndexFromCivil(year, month, day);
    const civil = civilFromDayIndex(index);
    if (
      year >= 1900 &&
      year <= 2100 &&
      civil.year === year &&
      civil.month === month &&
      civil.day === day
    ) {
      return index;
    }
  }
  return berlinDayIndex(now);
}

export function calendarRange(day: number, view: CalendarView) {
  let startDay = day;
  let endDay = day + 1;
  if (view === "month") {
    const { year, month } = civilFromDayIndex(day);
    const first = dayIndexFromCivil(year, month, 1);
    const next =
      month === 12 ? dayIndexFromCivil(year + 1, 1, 1) : dayIndexFromCivil(year, month + 1, 1);
    startDay = isoWeekStart(first);
    endDay = isoWeekStart(next - 1) + 7;
  } else if (view === "week") {
    startDay = isoWeekStart(day);
    endDay = startDay + 7;
  }
  return {
    startDay,
    endDay,
    from: new Date(berlinDayStartMs(startDay)),
    to: new Date(berlinDayStartMs(endDay)),
  };
}

export function calendarDays(startDay: number, endDay: number): number[] {
  return Array.from({ length: endDay - startDay }, (_, i) => startDay + i);
}

export function shiftCalendarDate(day: number, view: CalendarView, delta: number): number {
  if (view === "month") {
    const { year, month } = civilFromDayIndex(day);
    return berlinDayIndex(new TZDate(year, month - 1 + delta, 1, BERLIN_TZ));
  }
  return day + (view === "week" ? 7 : 1) * delta;
}

export function calendarSlotHref(day: number, hour = 9, roomId?: string, mobile = false): string {
  const date = dayIndexToDateKey(day);
  const startsAt = `${date}T${String(hour).padStart(2, "0")}:00`;
  const endDay = hour === 23 ? dayIndexToDateKey(day + 1) : date;
  const endsAt = `${endDay}T${String((hour + 1) % 24).padStart(2, "0")}:00`;
  const params = new URLSearchParams({ date, startsAt, endsAt });
  if (roomId) params.set("roomId", roomId);
  return `${mobile ? "/m" : ""}/events/new?${params}`;
}

export function eventsOnDay<T extends { startsAt: Date | string; endsAt: Date | string }>(
  events: T[],
  day: number,
): T[] {
  const from = berlinDayStartMs(day);
  const to = berlinDayStartMs(day + 1);
  return events.filter((event) => +new Date(event.endsAt) > from && +new Date(event.startsAt) < to);
}

export function dayHours(day: number): number[] {
  const from = berlinDayStartMs(day);
  const to = berlinDayStartMs(day + 1);
  return Array.from({ length: (to - from) / 3_600_000 }, (_, hour) => from + hour * 3_600_000);
}

export function instantSlotHref(start: number, roomId?: string): string {
  const params = new URLSearchParams({
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 3_600_000).toISOString(),
  });
  if (roomId) params.set("roomId", roomId);
  return `/events/new?${params}`;
}
