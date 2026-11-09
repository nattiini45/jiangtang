import { db } from "~/lib/db.server";

const ROOM_BOOKING_INCLUDE = {
  event: { select: { id: true, title: true, status: true } },
  room: { select: { id: true, name: true, slug: true } },
} as const;
const ALLOCATION_INCLUDE = {
  event: { select: { id: true, title: true, status: true } },
  equipment: { select: { id: true, name: true, assetTag: true, mobility: true, status: true } },
} as const;

export function listRoomBookings(
  options: {
    eventId?: string;
    roomId?: string;
    from?: Date;
    to?: Date;
    cancelled?: boolean;
    offset?: number;
    limit?: number;
  } = {},
) {
  return db.eventRoomBooking.findMany({
    where: {
      eventId: options.eventId,
      roomId: options.roomId,
      cancelled: options.cancelled ?? false,
      ...(options.from ? { endsAt: { gt: options.from } } : {}),
      ...(options.to ? { startsAt: { lt: options.to } } : {}),
    },
    include: ROOM_BOOKING_INCLUDE,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    skip: options.offset,
    take: options.limit,
  });
}

export function getRoomBooking(id: string) {
  return db.eventRoomBooking.findUnique({ where: { id }, include: ROOM_BOOKING_INCLUDE });
}

export function listEquipmentAllocations(
  options: {
    eventId?: string;
    equipmentId?: string;
    from?: Date;
    to?: Date;
    cancelled?: boolean;
    offset?: number;
    limit?: number;
  } = {},
) {
  return db.equipmentAllocation.findMany({
    where: {
      eventId: options.eventId,
      equipmentId: options.equipmentId,
      cancelled: options.cancelled ?? false,
      ...(options.from ? { endsAt: { gt: options.from } } : {}),
      ...(options.to ? { startsAt: { lt: options.to } } : {}),
    },
    include: ALLOCATION_INCLUDE,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    skip: options.offset,
    take: options.limit,
  });
}

export function getEquipmentAllocation(id: string) {
  return db.equipmentAllocation.findUnique({ where: { id }, include: ALLOCATION_INCLUDE });
}
