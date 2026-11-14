import type { EventStatus } from "~/generated/prisma/client";
import { db } from "~/lib/db.server";
import { calendarResourceMatches } from "~/lib/calendar-entries";
import { calendarSources, calendarChoices, type CalendarRange } from "./calendar.sources.server";

export { calendarChoices };

export async function getWorkspaceCalendar(
  opts: CalendarRange & {
    kinds: string[];
    roomId?: string;
    equipmentId?: string;
    status?: EventStatus;
  },
) {
  const { from, to, roomId, equipmentId, status } = opts;
  if (
    !Number.isFinite(+from) ||
    !Number.isFinite(+to) ||
    from >= to ||
    +to - +from > 366 * 86_400_000
  ) {
    throw new RangeError("Calendar range must be valid, increasing, and at most 366 days");
  }
  const [sources, bookings, rooms, equipment] = await Promise.all([
    Promise.all(
      calendarSources
        .filter((source) => opts.kinds.includes(source.choice.id))
        .map((source) => source.read({ from, to, roomId, equipmentId })),
    ),
    db.eventRoomBooking.findMany({
      where: { cancelled: false, startsAt: { lt: to }, endsAt: { gt: from }, roomId },
      select: {
        id: true,
        eventId: true,
        roomId: true,
        startsAt: true,
        endsAt: true,
        event: { select: { title: true, status: true } },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    }),
    db.room.findMany({
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    }),
    db.equipment.findMany({
      where: { status: { not: "RETIRED" } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        assetTag: true,
        category: true,
        model: { select: { name: true } },
      },
    }),
  ]);
  const entries = sources
    .flat()
    .filter(
      (entry) =>
        entry.startsAt < to &&
        entry.endsAt > from &&
        calendarResourceMatches(entry, roomId, equipmentId) &&
        (!status || !entry.status || entry.status === status),
    )
    .sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        +a.startsAt - +b.startsAt ||
        a.id.localeCompare(b.id),
    );
  return {
    entries,
    bookings: bookings.map(({ event, ...booking }) => ({ ...booking, ...event })),
    rooms,
    equipment: equipment.map((e) => ({
      id: e.id,
      label: [e.name ?? e.model?.name ?? e.category, e.assetTag].filter(Boolean).join(" · "),
    })),
  };
}
