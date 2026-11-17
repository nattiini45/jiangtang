import { berlinLocalToUtc } from "~/lib/time.server";
import { matchingEventInstant } from "./events.time";

export function resolveEventTime(local: string, instant?: string): Date {
  return matchingEventInstant(local, instant) ?? berlinLocalToUtc(local);
}

type Interval = { startsAt: Date; endsAt: Date };

export function moveEventInterval(slot: Interval, previous: Interval, next: Interval): Interval {
  const delta = +next.startsAt - +previous.startsAt;
  const fullWindow = +slot.startsAt === +previous.startsAt && +slot.endsAt === +previous.endsAt;
  return fullWindow
    ? { startsAt: next.startsAt, endsAt: next.endsAt }
    : { startsAt: new Date(+slot.startsAt + delta), endsAt: new Date(+slot.endsAt + delta) };
}
