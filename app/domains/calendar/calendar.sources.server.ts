import { Prisma } from "~/generated/prisma/client";
import { db } from "~/lib/db.server";
import { berlinDayIndex, berlinDayStartMs, dayIndexToDateKey } from "~/lib/berlin-days";
import { parseCalendarDate } from "~/lib/event-calendar";
import type { CalendarChoice, CalendarEntry } from "~/lib/calendar-entries";
import { SETTLED_TASK_STATUSES } from "~/domains/tasks/tasks.lanes";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";

export interface CalendarRange {
  from: Date;
  to: Date;
}

interface CalendarSource {
  id: string;
  choice: CalendarChoice;
  read: (range: CalendarRange) => Promise<CalendarEntry[]>;
}

const emptyResources = { rooms: [], equipment: [] };
const choice = (id: string, label: CalendarChoice["label"], defaultOn = true): CalendarChoice => ({
  id,
  label,
  defaultOn,
});
const datesChoice = choice("dates", "calendar.kinds.dates");

function linkedRooms(
  room: CalendarEntry["rooms"][number] | null | undefined,
  equipmentRoom: CalendarEntry["rooms"][number] | null | undefined,
) {
  return [
    ...new Map(
      [room, equipmentRoom].flatMap((item) => (item ? [[item.id, item] as const] : [])),
    ).values(),
  ];
}

function wholeDays(start: Date, end = start) {
  return {
    startsAt: new Date(berlinDayStartMs(berlinDayIndex(start))),
    endsAt: new Date(berlinDayStartMs(berlinDayIndex(end) + 1)),
    allDay: true,
  };
}

function wholeDayRange({ from, to }: CalendarRange) {
  const endDay = berlinDayIndex(to);
  return {
    from: new Date(berlinDayStartMs(berlinDayIndex(from))),
    to: new Date(berlinDayStartMs(endDay + Number(+to > berlinDayStartMs(endDay)))),
  };
}

function dateOverlap(from: Date, to: Date) {
  return {
    OR: [
      { startAt: { lt: to }, dueAt: { gte: from } },
      { startAt: null, dueAt: { gte: from, lt: to } },
      { dueAt: null, startAt: { gte: from, lt: to } },
    ],
  };
}

const events: CalendarSource = {
  id: "events",
  choice: choice("events", "nav.events"),
  async read({ from, to }) {
    const overlap = { cancelled: false, startsAt: { lt: to }, endsAt: { gt: from } };
    const rows = await db.event.findMany({
      where: { startsAt: { lt: to }, endsAt: { gt: from } },
      select: {
        id: true,
        title: true,
        startsAt: true,
        endsAt: true,
        status: true,
        rooms: { where: overlap, select: { room: { select: { id: true, name: true } } } },
        allocations: {
          where: overlap,
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
    });
    return rows.map(({ rooms, allocations, ...event }) => ({
      ...event,
      id: `event:${event.id}`,
      kind: "nav.events",
      allDay: false,
      href: `/events/${event.id}`,
      rooms: [...new Map(rooms.map(({ room }) => [room.id, room])).values()],
      equipment: [
        ...new Map(
          allocations.map(({ equipment: e }) => [
            e.id,
            { id: e.id, name: e.name ?? e.model?.name ?? e.assetTag ?? e.category },
          ]),
        ).values(),
      ],
    }));
  },
};

const service: CalendarSource = {
  id: "service",
  choice: choice("service", "calendar.kinds.service"),
  async read({ from, to }) {
    const rows = await db.serviceWindow.findMany({
      where: {
        startsAt: { lt: to },
        endsAt: { gt: from },
        event: { status: { not: "CANCELLED" } },
      },
      include: {
        event: {
          select: {
            title: true,
            status: true,
            allocations: {
              where: { cancelled: false, startsAt: { lt: to }, endsAt: { gt: from } },
              select: { equipment: { select: { id: true, name: true, assetTag: true } } },
            },
          },
        },
        room: { select: { id: true, name: true } },
      },
    });
    return rows.map((row) => ({
      id: `service:${row.id}`,
      kind: `events.serviceWindowKind.${row.kind}`,
      title: row.event.title,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      allDay: false,
      href: `/events/${row.eventId}`,
      status: row.event.status,
      rooms: row.room ? [row.room] : [],
      equipment: row.event.allocations.map(({ equipment: e }) => ({
        id: e.id,
        name: e.name ?? e.assetTag ?? e.id,
      })),
    }));
  },
};

const tasks: CalendarSource = {
  id: "tasks",
  choice: choice("tasks", "nav.tasks"),
  async read(range) {
    const { from, to } = wholeDayRange(range);
    const rows = await db.task.findMany({
      where: {
        ...dateOverlap(from, to),
        dueAt: { not: null },
        status: { notIn: [...SETTLED_TASK_STATUSES] },
      },
      select: {
        id: true,
        title: true,
        startAt: true,
        dueAt: true,
        ticket: {
          select: {
            room: { select: { id: true, name: true } },
            equipment: {
              select: {
                id: true,
                name: true,
                assetTag: true,
                room: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: `task:${row.id}`,
      kind: "nav.tasks",
      title: row.title,
      ...wholeDays(row.startAt ?? row.dueAt!, row.dueAt!),
      href: `/tasks/${row.id}`,
      rooms: linkedRooms(row.ticket?.room, row.ticket?.equipment?.room),
      equipment: row.ticket?.equipment
        ? [
            {
              id: row.ticket.equipment.id,
              name:
                row.ticket.equipment.name ??
                row.ticket.equipment.assetTag ??
                row.ticket.equipment.id,
            },
          ]
        : [],
    }));
  },
};

const projects: CalendarSource = {
  id: "projects",
  choice: choice("projects", "nav.projects"),
  async read(range) {
    const { from, to } = wholeDayRange(range);
    const rows = await db.project.findMany({
      where: dateOverlap(from, to),
      select: { id: true, name: true, slug: true, startAt: true, dueAt: true },
    });
    return rows.map((row) => ({
      ...emptyResources,
      id: `project:${row.id}`,
      kind: "nav.projects",
      title: row.name,
      ...wholeDays(row.startAt ?? row.dueAt!, row.dueAt ?? row.startAt!),
      href: `/projects/${row.slug}`,
    }));
  },
};

const renewals: CalendarSource = {
  id: "renewals",
  choice: datesChoice,
  async read(range) {
    const { from, to } = wholeDayRange(range);
    const rows = await db.room.findMany({
      where: {
        OR: [
          { renewalFrom: { lt: to }, renewalTo: { gte: from } },
          { renewalTo: null, renewalFrom: { gte: from, lt: to } },
          { renewalFrom: null, renewalTo: { gte: from, lt: to } },
        ],
      },
      select: { id: true, name: true, slug: true, renewalFrom: true, renewalTo: true },
    });
    return rows.map((row) => ({
      id: `renewal:${row.id}`,
      kind: "calendar.renewal",
      title: row.name,
      ...wholeDays(row.renewalFrom ?? row.renewalTo!, row.renewalTo ?? row.renewalFrom!),
      href: `/rooms/${row.slug}`,
      rooms: [{ id: row.id, name: row.name }],
      equipment: [],
    }));
  },
};

const warranties: CalendarSource = {
  id: "warranties",
  choice: datesChoice,
  async read(range) {
    const { from, to } = wholeDayRange(range);
    const rows = await db.inventoryItem.findMany({
      where: { warrantyExpiresAt: { gte: from, lt: to } },
      select: {
        id: true,
        name: true,
        warrantyExpiresAt: true,
        equipment: {
          select: {
            id: true,
            name: true,
            assetTag: true,
            room: { select: { id: true, name: true } },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: `warranty:${row.id}`,
      kind: "calendar.warranty",
      title: row.name,
      ...wholeDays(row.warrantyExpiresAt!),
      href: `/inventory/stock/${row.id}`,
      rooms: row.equipment?.room ? [row.equipment.room] : [],
      equipment: row.equipment
        ? [
            {
              id: row.equipment.id,
              name: row.equipment.name ?? row.equipment.assetTag ?? row.equipment.id,
            },
          ]
        : [],
    }));
  },
};

function fieldDates(scope: "ROOM" | "EQUIPMENT"): CalendarSource {
  return {
    id: `fields-${scope}`,
    choice: datesChoice,
    async read(range) {
      const { from, to } = wholeDayRange(range);
      const table = scope === "ROOM" ? Prisma.sql`"Room"` : Prisma.sql`"Equipment"`;
      const rows = await db.$queryRaw<
        {
          id: string;
          name: string;
          slug: string | null;
          roomId: string | null;
          roomName: string | null;
          fieldId: string;
          fieldName: string;
          value: string;
        }[]
      >(Prisma.sql`
        SELECT r.id, ${scope === "ROOM" ? Prisma.sql`r.name, r.slug, r.id AS "roomId", r.name AS "roomName"` : Prisma.sql`COALESCE(r.name, r."assetTag", r.id) AS name, NULL AS slug, r."roomId", room.name AS "roomName"`},
          f.id AS "fieldId", f.name AS "fieldName", r."customValues" ->> f.id AS value
        FROM ${table} r
        ${scope === "EQUIPMENT" ? Prisma.sql`LEFT JOIN "Room" room ON room.id = r."roomId"` : Prisma.empty}
        JOIN "CustomField" f ON f.scope::text = ${scope} AND f.type = 'DATE' AND f."archivedAt" IS NULL
        WHERE jsonb_typeof(r."customValues" -> f.id) = 'string'
          AND r."customValues" ->> f.id >= ${dayIndexToDateKey(berlinDayIndex(from))}
          AND r."customValues" ->> f.id < ${dayIndexToDateKey(berlinDayIndex(to))}
          ${scope === "EQUIPMENT" ? Prisma.sql`AND (NOT EXISTS (SELECT 1 FROM "CustomFieldKind" k WHERE k."fieldId" = f.id) OR EXISTS (SELECT 1 FROM "CustomFieldKind" k WHERE k."fieldId" = f.id AND k."kindId" = COALESCE(r."kindId", (SELECT id FROM "EquipmentKind" WHERE "systemKey" = (${JSON.stringify(Object.fromEntries(Object.entries(DEFAULT_EQUIPMENT_KINDS).map(([category, kind]) => [category, kind.key])))}::jsonb ->> r.category::text)))))` : Prisma.empty}
      `);
      return rows.flatMap((row) => {
        const day = parseCalendarDate(row.value);
        if (dayIndexToDateKey(day) !== row.value) return [];
        return [
          {
            id: `field:${scope}:${row.id}:${row.fieldId}`,
            kind: "calendar.kinds.dates",
            title: `${row.fieldName} · ${row.name}`,
            allDay: true,
            startsAt: new Date(berlinDayStartMs(day)),
            endsAt: new Date(berlinDayStartMs(day + 1)),
            href: scope === "ROOM" ? `/rooms/${row.slug}` : `/inventory/${row.id}`,
            rooms: row.roomId ? [{ id: row.roomId, name: row.roomName! }] : [],
            equipment: scope === "EQUIPMENT" ? [{ id: row.id, name: row.name }] : [],
          },
        ];
      });
    },
  };
}

const faults: CalendarSource = {
  id: "faults",
  choice: choice("faults", "calendar.kinds.faults", false),
  async read({ from, to }) {
    const rows = await db.ticket.findMany({
      where: { type: "INCIDENT", occurredAt: { gte: from, lt: to } },
      include: {
        room: { select: { id: true, name: true } },
        equipment: {
          select: {
            id: true,
            name: true,
            assetTag: true,
            room: { select: { id: true, name: true } },
          },
        },
      },
    });
    return rows.map((row) => ({
      id: `fault:${row.id}`,
      kind: "calendar.kinds.faults",
      title: row.title,
      startsAt: row.occurredAt,
      endsAt: new Date(+row.occurredAt + 1),
      allDay: false,
      point: true,
      href: `/tickets/${row.id}`,
      rooms: linkedRooms(row.room, row.equipment?.room),
      equipment: row.equipment
        ? [
            {
              id: row.equipment.id,
              name: row.equipment.name ?? row.equipment.assetTag ?? row.equipment.id,
            },
          ]
        : [],
    }));
  },
};

export const calendarSources: CalendarSource[] = [
  events,
  service,
  tasks,
  projects,
  renewals,
  warranties,
  fieldDates("ROOM"),
  fieldDates("EQUIPMENT"),
  faults,
];
export const calendarChoices = [
  ...new Map(calendarSources.map((source) => [source.choice.id, source.choice])).values(),
];
