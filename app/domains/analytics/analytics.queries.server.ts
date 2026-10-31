import { db } from "~/lib/db.server";

/**
 * Read-only analytics aggregations. Four dashboards:
 * failure rate by model ("which model fails most"), resolution times by ticket
 * type, technician workload (tickets closed), and room utilization (event-hours).
 *
 * Pure read-only: `findMany`/`groupBy` only — no mutations, no raw `$transaction`
 * (CI guard). Heavy lifting is done in Postgres via groupBy/raw where grouping is
 * cheaper than hauling rows to the app.
 */

export interface FailureRateRow {
  modelId: string;
  modelName: string;
  manufacturer: string | null;
  instanceCount: number;
  /** open + in-progress tickets linked to equipment of this model. */
  openTickets: number;
  /** resolved repair tickets (lifetime). */
  resolvedRepairs: number;
  /** openTickets per instance — the "which model fails most" ranking. */
  rate: number;
}

/** Tickets-per-model view: instance count vs. open + lifetime-resolved tickets. */
export async function failureRateByModel(): Promise<FailureRateRow[]> {
  const models = await db.equipmentModel.findMany({
    orderBy: [{ manufacturer: "asc" }, { name: "asc" }],
    include: { _count: { select: { instances: true } } },
  });

  // Open/incident tickets grouped by model (via equipment.modelId).
  const openByModel = await db.ticket.groupBy({
    by: ["equipmentId"],
    where: { status: { in: ["OPEN", "IN_PROGRESS"] }, equipment: { modelId: { not: null } } },
    _count: true,
  });
  // Resolved repair tickets grouped by model.
  const resolvedByModel = await db.ticket.groupBy({
    by: ["equipmentId"],
    where: { type: "REPAIR", status: "RESOLVED", equipment: { modelId: { not: null } } },
    _count: true,
  });

  // Resolve equipmentId → modelId in one pass (tickets reference equipment, not model).
  const equipmentIds = [
    ...new Set([...openByModel, ...resolvedByModel].map((r) => r.equipmentId)),
  ].filter((id): id is string => id !== null);
  const equip = await db.equipment.findMany({
    where: { id: { in: equipmentIds } },
    select: { id: true, modelId: true },
  });
  const modelOfEquip = new Map(equip.map((e) => [e.id, e.modelId]));

  const openCount = new Map<string, number>();
  const resolvedCount = new Map<string, number>();
  for (const r of openByModel) {
    const mid = r.equipmentId ? modelOfEquip.get(r.equipmentId) : undefined;
    if (mid) openCount.set(mid, (openCount.get(mid) ?? 0) + r._count);
  }
  for (const r of resolvedByModel) {
    const mid = r.equipmentId ? modelOfEquip.get(r.equipmentId) : undefined;
    if (mid) resolvedCount.set(mid, (resolvedCount.get(mid) ?? 0) + r._count);
  }

  return (
    models
      .map((m) => {
        const instanceCount = m._count.instances;
        const openTickets = openCount.get(m.id) ?? 0;
        const resolvedRepairs = resolvedCount.get(m.id) ?? 0;
        return {
          modelId: m.id,
          modelName: m.name,
          manufacturer: m.manufacturer,
          instanceCount,
          openTickets,
          resolvedRepairs,
          rate: instanceCount > 0 ? openTickets / instanceCount : 0,
        };
      })
      // Keep a model if it has instances, open tickets, OR a repair history — a
      // model whose last instance was retired should still show its resolved-repair
      // track record instead of vanishing from the dashboard.
      .filter((r) => r.instanceCount > 0 || r.openTickets > 0 || r.resolvedRepairs > 0)
      .sort((a, b) => b.rate - a.rate || b.openTickets - a.openTickets)
  );
}

export interface ResolutionTimeRow {
  type: "INCIDENT" | "REQUEST" | "REPAIR";
  count: number;
  /** median resolution time in hours (resolvedAt − occurredAt). */
  medianHours: number | null;
  meanHours: number | null;
}

/** Resolution-time stats (median/mean hours) per ticket type. */
export async function resolutionTimes(): Promise<ResolutionTimeRow[]> {
  // Fetch resolved tickets with both timestamps; compute median/mean in-app
  // (small N — the team is <20 people, tickets are hundreds, not millions).
  const tickets = await db.ticket.findMany({
    where: { status: "RESOLVED", resolvedAt: { not: null } },
    select: { type: true, occurredAt: true, resolvedAt: true },
  });

  const byType: Record<string, number[]> = { INCIDENT: [], REQUEST: [], REPAIR: [] };
  for (const t of tickets) {
    const hours = (t.resolvedAt!.getTime() - t.occurredAt.getTime()) / (1000 * 60 * 60);
    if (Number.isFinite(hours) && hours >= 0) byType[t.type]?.push(hours);
  }

  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

  return (["INCIDENT", "REQUEST", "REPAIR"] as const).map((type) => {
    const xs = byType[type];
    return { type, count: xs.length, medianHours: median(xs), meanHours: mean(xs) };
  });
}

export interface TechWorkloadRow {
  initials: string;
  name: string;
  closedCount: number;
}

/**
 * Tickets closed per technician. Sourced from ActivityLog's TicketResolved rows
 * (the immutable actor snapshot carries initials — survives rename/erasure per
 * — aggregated by initials since the snapshot is the durable key.
 */
export async function techWorkload(): Promise<TechWorkloadRow[]> {
  const rows = await db.activityLog.findMany({
    where: { action: "TicketResolved" },
    select: { actorSnapshot: true },
  });
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  for (const r of rows) {
    const snap = r.actorSnapshot as { initials?: unknown; name?: unknown } | null;
    const initials = typeof snap?.initials === "string" && snap.initials ? snap.initials : "?";
    const fullName =
      typeof snap?.name === "string" && snap.name.trim() ? snap.name.trim() : undefined;
    // Initials may be a composite ("TA+CS") — count each. The snapshot's `name`
    // reflects the whole acting group in that case, so it's only trustworthy as
    // a real per-tech name when there's exactly one initials segment.
    const segments = initials
      .split(/[+/]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const init of segments) {
      counts.set(init, (counts.get(init) ?? 0) + 1);
      if (segments.length === 1 && fullName && !names.has(init)) names.set(init, fullName);
    }
  }
  return [...counts.entries()]
    .map(([initials, closedCount]) => ({
      initials,
      name: names.get(initials) ?? initials,
      closedCount,
    }))
    .sort((a, b) => b.closedCount - a.closedCount);
}

export interface RoomUtilizationRow {
  roomId: string;
  roomName: string;
  roomSlug: string;
  /** total event-hours in the window (non-cancelled bookings). */
  eventHours: number;
  eventCount: number;
}

/**
 * Event-hours per room in a window (from non-cancelled EventRoomBooking).
 * Uses overlap semantics (starts before the window ends AND ends after the
 * window starts) rather than "fully contained", so a booking that crosses a
 * window boundary is still counted — clamped to the portion inside `[from, to)`
 * so it doesn't over-count hours outside the requested window.
 */
export async function roomUtilization(from: Date, to: Date): Promise<RoomUtilizationRow[]> {
  const bookings = await db.eventRoomBooking.findMany({
    where: { cancelled: false, startsAt: { lt: to }, endsAt: { gt: from } },
    include: { room: { select: { id: true, name: true, slug: true } } },
  });
  const byRoom = new Map<string, RoomUtilizationRow>();
  for (const b of bookings) {
    const clampedStart =
      b.startsAt.getTime() < from.getTime() ? from.getTime() : b.startsAt.getTime();
    const clampedEnd = b.endsAt.getTime() > to.getTime() ? to.getTime() : b.endsAt.getTime();
    const hours = (clampedEnd - clampedStart) / (1000 * 60 * 60);
    const existing = byRoom.get(b.roomId);
    if (existing) {
      existing.eventHours += hours;
      existing.eventCount += 1;
    } else {
      byRoom.set(b.roomId, {
        roomId: b.room.id,
        roomName: b.room.name,
        roomSlug: b.room.slug,
        eventHours: hours,
        eventCount: 1,
      });
    }
  }
  return [...byRoom.values()].sort((a, b) => b.eventHours - a.eventHours);
}
