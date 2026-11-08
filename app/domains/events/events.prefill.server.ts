import { berlinLocalToUtc, utcToBerlinLocal } from "~/lib/time.server";
import { z } from "zod";
import { resolveEventTime } from "./events.time.server";

export function creationLocalDateTime(value: string | null): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  try {
    const instant = berlinLocalToUtc(value);
    return utcToBerlinLocal(instant) === value ? value : undefined;
  } catch {
    return undefined;
  }
}

export function eventCreationPrefill(params: URLSearchParams, rooms: { id: string }[]) {
  const readTime = (value: string | null) => {
    const local = creationLocalDateTime(value);
    if (local) return { local, instant: undefined };
    if (!z.iso.datetime({ offset: true }).safeParse(value).success) return undefined;
    const instant = new Date(value!);
    if (instant.getUTCSeconds() || instant.getUTCMilliseconds()) return undefined;
    return { local: utcToBerlinLocal(instant), instant: instant.toISOString() };
  };
  const start = readTime(params.get("startsAt"));
  const end = readTime(params.get("endsAt"));
  const validRange =
    start &&
    end &&
    resolveEventTime(start.local, start.instant) < resolveEventTime(end.local, end.instant);
  const date = params.get("date");
  const validDate = date && creationLocalDateTime(`${date}T12:00`);
  const roomId = params.get("roomId");
  return {
    startsAt: validRange ? start.local : "",
    endsAt: validRange ? end.local : "",
    startsAtInstant: validRange ? start.instant : undefined,
    endsAtInstant: validRange ? end.instant : undefined,
    roomId: rooms.some((room) => room.id === roomId) ? roomId! : "",
    date: validRange ? start.local.slice(0, 10) : validDate ? date : "",
  };
}
