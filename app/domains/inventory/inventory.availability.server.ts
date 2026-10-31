import { db } from "~/lib/db.server";

/**
 * Pooled-equipment availability ("pooled-equipment availability
 * timeline"). Read-only: returns the non-cancelled allocations of pooled units
 * within a window so the UI can render a Gantt-style booked/free strip. This is
 * distinct from event-time conflict detection: it's a utilization view across
 * ALL events for a unit (or all units of a model).
 */

export interface AllocationWindow {
  allocationId: string;
  equipmentId: string;
  eventId: string;
  eventTitle: string;
  eventStatus: string;
  startsAt: Date;
  endsAt: Date;
}

/**
 * Allocations overlapping `[from, to)` for the given pooled unit. Cancelled
 * allocations are excluded (they free the unit, matching the EXCLUDE predicate).
 */
export async function unitAvailability(
  equipmentId: string,
  from: Date,
  to: Date,
): Promise<AllocationWindow[]> {
  const rows = await db.equipmentAllocation.findMany({
    where: {
      equipmentId,
      cancelled: false,
      startsAt: { lt: to },
      endsAt: { gt: from },
    },
    include: { event: { select: { id: true, title: true, status: true } } },
    orderBy: { startsAt: "asc" },
  });
  return rows.map((a) => ({
    allocationId: a.id,
    equipmentId: a.equipmentId,
    eventId: a.event.id,
    eventTitle: a.event.title,
    eventStatus: a.event.status,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
  }));
}

export interface UnitAvailabilityRow {
  equipmentId: string;
  equipmentLabel: string;
  assetTag: string | null;
  windows: AllocationWindow[];
}
