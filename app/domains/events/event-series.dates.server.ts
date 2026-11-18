import { berlinDateKey, berlinOffsetMs, isoWeekday, isoWeekStart } from "~/lib/berlin-days";
import type { EventSeriesInput } from "./event-series.schema";

const DAY_MS = 86_400_000;

export function seriesHorizon(now: Date, days = 366): string {
  return dayKey(Date.parse(berlinDateKey(now)) / DAY_MS + days);
}

function dayKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

export function* seriesDates({ event, rule, end }: EventSeriesInput) {
  const start = Date.parse(event.startsAt.slice(0, 10)) / DAY_MS;
  const dayOfMonth = new Date(start * DAY_MS).getUTCDate();
  const lastDay = end.kind === "date" ? Date.parse(end.date) / DAY_MS : Infinity;
  const count = end.kind === "count" ? end.count : Infinity;
  for (let day = start, emitted = 0; day <= lastDay && emitted < count; day++) {
    if (
      rule.frequency === "weekly" &&
      (!rule.weekdays.includes(isoWeekday(day)) ||
        ((isoWeekStart(day) - isoWeekStart(start)) / 7) % rule.interval !== 0)
    )
      continue;
    if (rule.frequency === "monthly" && new Date(day * DAY_MS).getUTCDate() !== dayOfMonth)
      continue;
    emitted++;
    yield dayKey(day);
  }
}

export function occurrenceTimes(event: EventSeriesInput["event"], date: string) {
  const shift = Date.parse(date) - Date.parse(event.startsAt.slice(0, 10));
  const start = Date.parse(event.startsAt + "Z") + shift;
  const end = Date.parse(event.endsAt + "Z") + shift;
  const startsAt = berlinTime(start);
  const endsAt = berlinTime(end);
  return {
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt > startsAt ? endsAt : startsAt + end - start),
  };
}

function berlinTime(wall: number): number {
  const earlierOffset = berlinOffsetMs(wall - DAY_MS);
  const laterOffset = berlinOffsetMs(wall + DAY_MS);
  const first = wall - earlierOffset;
  const second = wall - laterOffset;
  return first + berlinOffsetMs(first) === wall || second + berlinOffsetMs(second) !== wall
    ? first
    : second;
}
