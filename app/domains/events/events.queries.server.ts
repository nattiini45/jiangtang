import { tr } from "~/i18n/request-locale.server";
import { db } from "~/lib/db.server";
import type {
  EventStatus,
  ServiceWindowKind,
  TicketStatus,
  TicketType,
} from "~/generated/prisma/client";
import { listRooms } from "~/domains/rooms/rooms.queries.server";
import { listEquipment } from "~/domains/inventory/inventory.queries.server";

/** Read-only queries for the events domain (list, detail, conflict pre-checks, pickers). */

export interface EventListRow {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  status: EventStatus;
  organizer: string | null;
  roomCount: number;
}

export async function listEvents(opts?: {
  status?: EventStatus;
  q?: string;
  /** Optional `startsAt` window (UTC instants) — the mobile events list reads
   *  "today"/"this week" through it instead of loading every event. */
  from?: Date;
  to?: Date;
}): Promise<EventListRow[]> {
  const events = await db.event.findMany({
    where: {
      status: opts?.status,
      ...(opts?.q ? { title: { contains: opts.q, mode: "insensitive" } } : {}),
      ...(opts?.from || opts?.to
        ? {
            startsAt: {
              ...(opts?.from ? { gte: opts.from } : {}),
              ...(opts?.to ? { lt: opts.to } : {}),
            },
          }
        : {}),
    },
    orderBy: [{ startsAt: "desc" }],
    include: { rooms: { where: { cancelled: false }, select: { id: true } } },
  });
  return events.map((e) => ({
    id: e.id,
    title: e.title,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    status: e.status,
    organizer: e.organizer,
    roomCount: e.rooms.length,
  }));
}

export interface EventRoomRow {
  id: string;
  roomId: string;
  roomName: string;
  roomSlug: string;
  startsAt: Date;
  endsAt: Date;
}
export interface EventAllocationRow {
  id: string;
  equipmentId: string;
  equipmentName: string;
  startsAt: Date;
  endsAt: Date;
}
export interface EventServiceWindowRow {
  id: string;
  kind: ServiceWindowKind;
  roomName: string | null;
  startsAt: Date;
  endsAt: Date;
  covering: string | null;
  notes: string | null;
}
export interface EventTicketRow {
  id: string;
  type: TicketType;
  status: TicketStatus;
  title: string;
}

export interface EventDetail {
  event: {
    id: string;
    uid: string;
    title: string;
    description: string | null;
    startsAt: Date;
    endsAt: Date;
    status: EventStatus;
    organizer: string | null;
    contact: string | null;
  };
  rooms: EventRoomRow[];
  allocations: EventAllocationRow[];
  serviceWindows: EventServiceWindowRow[];
  tickets: EventTicketRow[];
}

/** Full event with its active bookings/allocations/windows + linked tickets. */
export async function getEventDetail(id: string): Promise<EventDetail | null> {
  const event = await db.event.findUnique({
    where: { id },
    include: {
      rooms: {
        where: { cancelled: false },
        orderBy: { startsAt: "asc" },
        include: { room: { select: { name: true, slug: true } } },
      },
      allocations: {
        where: { cancelled: false },
        orderBy: { startsAt: "asc" },
        include: { equipment: { select: { name: true, assetTag: true } } },
      },
      serviceWindows: {
        orderBy: { startsAt: "asc" },
        include: {
          room: { select: { name: true } },
          coveringUser: { select: { name: true, initials: true } },
        },
      },
      tickets: {
        orderBy: { occurredAt: "desc" },
        select: { id: true, type: true, status: true, title: true },
      },
    },
  });
  if (!event) return null;

  return {
    event: {
      id: event.id,
      uid: event.uid,
      title: event.title,
      description: event.description,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      status: event.status,
      organizer: event.organizer,
      contact: event.contact,
    },
    rooms: event.rooms.map((b) => ({
      id: b.id,
      roomId: b.roomId,
      roomName: b.room.name,
      roomSlug: b.room.slug,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
    })),
    allocations: event.allocations.map((a) => ({
      id: a.id,
      equipmentId: a.equipmentId,
      equipmentName: a.equipment.name ?? a.equipment.assetTag ?? tr("history.entity.equipment"),
      startsAt: a.startsAt,
      endsAt: a.endsAt,
    })),
    serviceWindows: event.serviceWindows.map((w) => ({
      id: w.id,
      kind: w.kind,
      roomName: w.room?.name ?? null,
      startsAt: w.startsAt,
      endsAt: w.endsAt,
      covering: w.coveringUser ? (w.coveringUser.initials ?? w.coveringUser.name) : null,
      notes: w.notes,
    })),
    tickets: event.tickets,
  };
}

// Conflicts are surfaced authoritatively at save: the DB GiST EXCLUDE rejects an
// overlap (23P01) and insertOrConflict turns it into a BookingConflictError the
// add-forms render inline. A speculative pre-check query would need the chosen
// room/time, so it belongs with a future fetcher-driven (JS) picker — not added
// here to avoid unused surface area.

// ── Picker targets ───────────────────────────────────────────────────────────

export interface EventTargets {
  rooms: { id: string; name: string }[];
  pooledEquipment: { id: string; label: string }[];
  users: { id: string; name: string; initials: string | null }[];
}

/** Rooms, allocatable pooled equipment, and covering users for the event forms. */
export async function listEventTargets(): Promise<EventTargets> {
  const [rooms, equipment, users] = await Promise.all([
    listRooms(),
    listEquipment({ mobility: "POOLED" }),
    db.user.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, initials: true },
    }),
  ]);
  return {
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.roomNumber ? `${r.name} (${r.roomNumber})` : r.name,
    })),
    pooledEquipment: equipment
      .filter((e) => e.status !== "RETIRED")
      .map((e) => ({
        id: e.id,
        label: [e.name ?? e.modelName ?? e.category, e.assetTag].filter(Boolean).join(" · "),
      })),
    users,
  };
}
