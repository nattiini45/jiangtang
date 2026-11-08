import type { EventStatus, Prisma } from "~/generated/prisma/client";
import { SETTLED_TASK_STATUSES } from "~/domains/tasks/tasks.lanes";
import { db } from "~/lib/db.server";

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  status: EventStatus;
  rooms: { id: string; name: string }[];
  equipment: { id: string; name: string }[];
}

export interface CalendarBooking {
  id: string;
  eventId: string;
  title: string;
  roomId: string;
  startsAt: Date;
  endsAt: Date;
  status: EventStatus;
}

export interface CalendarTask {
  id: string;
  title: string;
  dueAt: Date;
}

export async function getCalendarData(opts: {
  from: Date;
  to: Date;
  roomId?: string;
  equipmentId?: string;
  status?: EventStatus;
  includeTasks?: boolean;
}): Promise<{
  events: CalendarEvent[];
  bookings: CalendarBooking[];
  rooms: { id: string; name: string }[];
  equipment: { id: string; label: string }[];
  tasks: CalendarTask[];
}> {
  const { from, to, roomId, equipmentId, status } = opts;
  if (
    !(from instanceof Date) ||
    !(to instanceof Date) ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from >= to ||
    to.getTime() - from.getTime() > 366 * 24 * 60 * 60 * 1000
  ) {
    throw new RangeError("Calendar range must be valid, increasing, and at most 366 days");
  }

  const overlap = { startsAt: { lt: to }, endsAt: { gt: from } };
  const activeOverlap = { cancelled: false, ...overlap };
  const eventFilters: Prisma.EventWhereInput = {
    status,
    ...(roomId !== undefined ? { rooms: { some: { roomId, ...activeOverlap } } } : {}),
    ...(equipmentId !== undefined
      ? { allocations: { some: { equipmentId, ...activeOverlap } } }
      : {}),
  };
  const [events, bookings, rooms, equipment, tasks] = await Promise.all([
    db.event.findMany({
      where: { ...overlap, ...eventFilters },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        title: true,
        startsAt: true,
        endsAt: true,
        status: true,
        rooms: {
          where: activeOverlap,
          orderBy: [{ room: { name: "asc" } }, { id: "asc" }],
          select: { room: { select: { id: true, name: true } } },
        },
        allocations: {
          where: activeOverlap,
          orderBy: [{ equipmentId: "asc" }, { id: "asc" }],
          select: {
            equipment: {
              select: {
                id: true,
                name: true,
                assetTag: true,
                category: true,
                model: { select: { name: true } },
              },
            },
          },
        },
      },
    }),
    db.eventRoomBooking.findMany({
      where: { ...activeOverlap, roomId },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        eventId: true,
        roomId: true,
        startsAt: true,
        endsAt: true,
        event: { select: { title: true, status: true } },
      },
    }),
    db.room.findMany({
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true },
    }),
    db.equipment.findMany({
      where: { mobility: "POOLED", status: { not: "RETIRED" } },
      orderBy: [{ category: "asc" }, { name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        assetTag: true,
        category: true,
        model: { select: { name: true } },
      },
    }),
    opts.includeTasks
      ? db.task.findMany({
          where: {
            dueAt: { gte: from, lt: to },
            status: { notIn: [...SETTLED_TASK_STATUSES] },
          },
          orderBy: [{ dueAt: "asc" }, { id: "asc" }],
          select: { id: true, title: true, dueAt: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    events: events.map(({ rooms, allocations, ...event }) => ({
      ...event,
      rooms: [...new Map(rooms.map(({ room }) => [room.id, room])).values()],
      equipment: [
        ...new Map(
          allocations.map(({ equipment: e }) => [
            e.id,
            { id: e.id, name: e.name ?? e.model?.name ?? e.assetTag ?? e.category },
          ]),
        ).values(),
      ],
    })),
    bookings: bookings.map(({ event, ...booking }) => ({ ...booking, ...event })),
    rooms,
    equipment: equipment.map((e) => ({
      id: e.id,
      label: [e.name ?? e.model?.name ?? e.category, e.assetTag].filter(Boolean).join(" · "),
    })),
    tasks: tasks.flatMap((task) => (task.dueAt ? [{ ...task, dueAt: task.dueAt }] : [])),
  };
}
