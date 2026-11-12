import type { EventStatus } from "~/generated/prisma/client";
import type { MessageKey } from "~/i18n";
import { berlinDayIndex } from "~/lib/berlin-days";

export interface CalendarEntry {
  id: string;
  kind: MessageKey;
  title: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  href: string;
  status?: EventStatus;
  rooms: { id: string; name: string }[];
  equipment: { id: string; name: string }[];
}

export interface CalendarChoice {
  id: string;
  label: MessageKey;
  defaultOn: boolean;
}

export function calendarBandEntry(entry: CalendarEntry): boolean {
  return (
    entry.allDay ||
    berlinDayIndex(+new Date(entry.endsAt) - 1) > berlinDayIndex(new Date(entry.startsAt))
  );
}

export function calendarKinds(params: URLSearchParams, choices: CalendarChoice[]): string[] {
  if (params.has("kinds")) {
    const selected = params.getAll("kinds").flatMap((value) => value.split(","));
    return choices.filter((choice) => selected.includes(choice.id)).map((choice) => choice.id);
  }
  return choices
    .filter((choice) => choice.defaultOn && (choice.id !== "tasks" || params.get("tasks") !== "0"))
    .map((choice) => choice.id);
}

export function calendarResourceMatches(
  entry: Pick<CalendarEntry, "rooms" | "equipment">,
  roomId?: string,
  equipmentId?: string,
): boolean {
  return (
    (!roomId || entry.rooms.some((room) => room.id === roomId)) &&
    (!equipmentId || entry.equipment.some((item) => item.id === equipmentId))
  );
}

export function legacyCalendarHref(params: URLSearchParams): string | null {
  const view = params.get("view");
  if (!view || !["month", "week", "day", "rooms", "calendar"].includes(view)) return null;
  const target = new URLSearchParams(params);
  if (view === "calendar") target.set("view", "month");
  return `/calendar?${target}`;
}
