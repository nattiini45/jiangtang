import { db } from "~/lib/db.server";

/**
 * Read-only conflict PRE-check (the allocation UI should surface
 * conflicts BEFORE save). The DB GiST EXCLUDE constraint remains the authority
 * (it raises 23P01 at insert → BookingConflictError → 409); these queries are an
 * accelerator so the UI can show a red badge and disable submit before the round
 * trip. Half-open `[)` ranges: back-to-back bookings that merely touch do NOT
 * conflict — matching the frozen `during` EXCLUDE semantics.
 *
 * `excludeBookingId`/`excludeAllocationId` let the pre-check ignore the row
 * being edited (an edit of an existing booking shouldn't conflict with itself).
 */

export interface RoomConflict {
  bookingId: string;
  eventId: string;
  eventTitle: string;
  startsAt: Date;
  endsAt: Date;
}

export interface EquipmentConflict {
  allocationId: string;
  eventId: string;
  eventTitle: string;
  startsAt: Date;
  endsAt: Date;
}

/** Find non-cancelled room bookings that overlap [startsAt, endsAt). */
export async function findRoomConflicts(
  roomId: string,
  startsAt: Date,
  endsAt: Date,
  excludeBookingId?: string,
): Promise<RoomConflict[]> {
  const rows = await db.eventRoomBooking.findMany({
    where: {
      roomId,
      cancelled: false,
      // Half-open overlap: existing.startsAt < endsAt AND startsAt < existing.endsAt
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
    },
    include: { event: { select: { id: true, title: true } } },
    orderBy: { startsAt: "asc" },
  });
  return rows.map((b) => ({
    bookingId: b.id,
    eventId: b.event.id,
    eventTitle: b.event.title,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
  }));
}

/** Find non-cancelled allocations of a pooled unit that overlap [startsAt, endsAt). */
export async function findEquipmentConflicts(
  equipmentId: string,
  startsAt: Date,
  endsAt: Date,
  excludeAllocationId?: string,
): Promise<EquipmentConflict[]> {
  const rows = await db.equipmentAllocation.findMany({
    where: {
      equipmentId,
      cancelled: false,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
      ...(excludeAllocationId ? { id: { not: excludeAllocationId } } : {}),
    },
    include: { event: { select: { id: true, title: true } } },
    orderBy: { startsAt: "asc" },
  });
  return rows.map((a) => ({
    allocationId: a.id,
    eventId: a.event.id,
    eventTitle: a.event.title,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
  }));
}

/** Batch variant: conflicts for a set of pooled units over one window. */
export async function findEquipmentConflictsBatch(
  equipmentIds: string[],
  startsAt: Date,
  endsAt: Date,
): Promise<Record<string, EquipmentConflict[]>> {
  if (equipmentIds.length === 0) return {};
  const rows = await db.equipmentAllocation.findMany({
    where: {
      equipmentId: { in: equipmentIds },
      cancelled: false,
      startsAt: { lt: endsAt },
      endsAt: { gt: startsAt },
    },
    include: { event: { select: { id: true, title: true } } },
    orderBy: { startsAt: "asc" },
  });
  const out: Record<string, EquipmentConflict[]> = {};
  for (const a of rows) {
    const arr = out[a.equipmentId] ?? [];
    arr.push({
      allocationId: a.id,
      eventId: a.event.id,
      eventTitle: a.event.title,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
    });
    out[a.equipmentId] = arr;
  }
  return out;
}
