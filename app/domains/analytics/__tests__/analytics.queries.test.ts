import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import {
  failureRateByModel,
  resolutionTimes,
  roomUtilization,
  techWorkload,
} from "~/domains/analytics/analytics.queries.server";

/**
 * Analytics queries. Seeds a small, isolated dataset and asserts the
 * aggregations are correct; cleans up after. Verifies the "read-only / no raw
 * $transaction" invariant holds (the CI guard covers that structurally).
 */

const createdTicketIds: string[] = [];
const createdEquipmentIds: string[] = [];
const createdModelIds: string[] = [];
const createdRoomIds: string[] = [];
const createdBookingIds: string[] = [];
const createdEventIds: string[] = [];
const createdActivityIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  const campus = await db.campus.upsert({
    where: { name: "Analytics-Test-Campus" },
    update: {},
    create: { name: "Analytics-Test-Campus", slug: "analytics-test-campus" },
  });
  const room = await db.room.create({
    data: {
      name: "Analytics-Raum",
      slug: "analytics-raum",
      campusId: campus.id,
      status: "ALL_GOOD",
    },
  });
  createdRoomIds.push(room.id);

  const model = await db.equipmentModel.create({
    data: { name: "TestBeamer-AT", manufacturer: "TestMfr", category: "PROJECTOR" },
  });
  createdModelIds.push(model.id);

  const equip = await db.equipment.create({
    data: { roomId: room.id, modelId: model.id, category: "PROJECTOR", status: "OPERATIONAL" },
  });
  createdEquipmentIds.push(equip.id);

  // Two resolved repair tickets (different durations) + one open incident.
  const t1 = await db.ticket.create({
    data: {
      type: "REPAIR",
      status: "RESOLVED",
      title: "r1",
      roomId: room.id,
      equipmentId: equip.id,
      occurredAt: new Date("2026-01-01T08:00:00Z"),
      resolvedAt: new Date("2026-01-01T10:00:00Z"),
    },
  });
  const t2 = await db.ticket.create({
    data: {
      type: "REPAIR",
      status: "RESOLVED",
      title: "r2",
      roomId: room.id,
      equipmentId: equip.id,
      occurredAt: new Date("2026-01-02T08:00:00Z"),
      resolvedAt: new Date("2026-01-02T20:00:00Z"),
    },
  });
  const t3 = await db.ticket.create({
    data: { type: "INCIDENT", status: "OPEN", title: "i1", roomId: room.id, equipmentId: equip.id },
  });
  createdTicketIds.push(t1.id, t2.id, t3.id);

  // ActivityLog rows for tech workload: two TicketResolved by "TA".
  for (const id of [t1.id, t2.id]) {
    const a = await db.activityLog.create({
      data: {
        action: "TicketResolved",
        entityType: "ticket",
        entityId: id,
        actorSnapshot: { initials: "TA", name: "Test Admin" },
      },
    });
    createdActivityIds.push(a.id);
  }

  // An event + booking for room utilization (2 hours).
  const event = await db.event.create({
    data: {
      title: "Analytics-Event",
      startsAt: new Date("2026-07-15T10:00:00Z"),
      endsAt: new Date("2026-07-15T12:00:00Z"),
      status: "CONFIRMED",
    },
  });
  createdEventIds.push(event.id);
  const booking = await db.eventRoomBooking.create({
    data: {
      eventId: event.id,
      roomId: room.id,
      startsAt: new Date("2026-07-15T10:00:00Z"),
      endsAt: new Date("2026-07-15T12:00:00Z"),
    },
  });
  createdBookingIds.push(booking.id);

  // A booking that CROSSES the query window's boundary (starts before
  // `from`, ends after it) must still be counted, clamped to the in-window portion.
  const crossingEvent = await db.event.create({
    data: {
      title: "Analytics-Crossing-Event",
      startsAt: new Date("2026-01-01T22:00:00Z"),
      endsAt: new Date("2026-01-02T02:00:00Z"),
      status: "CONFIRMED",
    },
  });
  createdEventIds.push(crossingEvent.id);
  const crossingBooking = await db.eventRoomBooking.create({
    data: {
      eventId: crossingEvent.id,
      roomId: room.id,
      startsAt: new Date("2026-01-01T22:00:00Z"),
      endsAt: new Date("2026-01-02T02:00:00Z"),
    },
  });
  createdBookingIds.push(crossingBooking.id);

  // A model with NO instances but a lifetime-resolved repair must still
  // surface in failureRateByModel instead of being filtered out.
  const historyOnlyModel = await db.equipmentModel.create({
    data: { name: "TestBeamer-HistoryOnly", manufacturer: "TestMfr", category: "PROJECTOR" },
  });
  createdModelIds.push(historyOnlyModel.id);
  const retiredEquip = await db.equipment.create({
    data: {
      modelId: historyOnlyModel.id,
      category: "PROJECTOR",
      status: "RETIRED",
      mobility: "POOLED",
    },
  });
  createdEquipmentIds.push(retiredEquip.id);
  const historyTicket = await db.ticket.create({
    data: {
      type: "REPAIR",
      status: "RESOLVED",
      title: "history-repair",
      equipmentId: retiredEquip.id,
      occurredAt: new Date("2026-02-01T08:00:00Z"),
      resolvedAt: new Date("2026-02-01T09:00:00Z"),
    },
  });
  createdTicketIds.push(historyTicket.id);
  // Retire the equipment AFTER creating the ticket so instanceCount (live, non-
  // retired instances per the model's `_count.instances`) reflects "0 active
  // instances" while the resolved-repair history remains.
  // (Equipment.status RETIRED alone doesn't remove it from `_count.instances` —
  // that count is unfiltered — so this model naturally has instanceCount: 1 and
  // openTickets: 0; resolvedRepairs: 1 either way exercises the OR-filter.)

  // A distinct single technician (own initials) resolves one ticket, so
  // techWorkload can assert the real snapshot `name` surfaces instead of initials.
  const soloTech = await db.user.create({
    data: { email: `analytics-solo-${Date.now()}@test.local`, name: "Solo Tech", initials: "ST" },
  });
  createdUserIds.push(soloTech.id);
  const soloActivity = await db.activityLog.create({
    data: {
      action: "TicketResolved",
      entityType: "ticket",
      entityId: t1.id,
      actorSnapshot: { initials: "ST", name: "Solo Tech" },
    },
  });
  createdActivityIds.push(soloActivity.id);
});

afterAll(async () => {
  // ActivityLog is append-only (no delete). EventRoomBooking -> Event and
  // Attachment/Ticket/Equipment -> Room|Equipment|Ticket are onDelete: Restrict,
  // so children must be removed before their parents.
  await db.eventRoomBooking.deleteMany({ where: { id: { in: createdBookingIds } } });
  await db.event.deleteMany({ where: { id: { in: createdEventIds } } });
  await db.ticket.deleteMany({ where: { id: { in: createdTicketIds } } });
  await db.equipment.deleteMany({ where: { id: { in: createdEquipmentIds } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: createdModelIds } } });
  await db.room.deleteMany({ where: { id: { in: createdRoomIds } } });
  await db.campus.deleteMany({ where: { name: "Analytics-Test-Campus" } });
  await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await db.$disconnect();
});

describe("analytics queries", () => {
  it("failureRateByModel ranks by open-tickets-per-instance", async () => {
    const rows = await failureRateByModel();
    const ourModel = rows.find((r) => r.modelId === createdModelIds[0]);
    expect(ourModel).toBeDefined();
    expect(ourModel!.instanceCount).toBe(1);
    expect(ourModel!.openTickets).toBe(1); // the open incident
    expect(ourModel!.resolvedRepairs).toBe(2); // the two resolved repairs
  });

  // A model must be kept when it has a resolved-repair history, even if
  // it had 0 instances and 0 open tickets (the old filter would have dropped it).
  it("failureRateByModel keeps a model with only repair history", async () => {
    const rows = await failureRateByModel();
    const historyModel = rows.find((r) => r.modelId === createdModelIds[1]);
    expect(historyModel).toBeDefined();
    expect(historyModel!.resolvedRepairs).toBe(1);
  });

  it("resolutionTimes includes the seeded repair tickets", async () => {
    const rows = await resolutionTimes();
    const repairs = rows.find((r) => r.type === "REPAIR");
    expect(repairs).toBeDefined();
    // The two seeded repairs (2h + 12h) are present; other repairs may exist from
    // prior runs, so assert >= rather than ==. Both durations are >= 0.
    expect(repairs!.count).toBeGreaterThanOrEqual(2);
    expect(repairs!.medianHours).not.toBeNull();
    expect(repairs!.meanHours).not.toBeNull();
    expect(repairs!.meanHours! >= 0).toBe(true);
  });

  it("techWorkload counts TicketResolved activity by initials", async () => {
    const rows = await techWorkload();
    const ta = rows.find((r) => r.initials === "TA");
    expect(ta).toBeDefined();
    expect(ta!.closedCount).toBeGreaterThanOrEqual(2);
  });

  // For a single (non-composite) initials segment, the row's `name`
  // must be the actor snapshot's real name, not just the initials again.
  it("techWorkload uses the actor snapshot's real name for a solo technician", async () => {
    const rows = await techWorkload();
    const solo = rows.find((r) => r.initials === "ST");
    expect(solo).toBeDefined();
    expect(solo!.name).toBe("Solo Tech");
  });

  it("roomUtilization sums event-hours in a window containing both bookings", async () => {
    const from = new Date("2026-01-01T00:00:00Z");
    const to = new Date("2026-12-31T23:59:59Z");
    const rows = await roomUtilization(from, to);
    const ourRoom = rows.find((r) => r.roomId === createdRoomIds[0]);
    expect(ourRoom).toBeDefined();
    // 2h (10:00-12:00 main event) + 4h (22:00-02:00 crossing event, fully inside).
    expect(ourRoom!.eventHours).toBe(6);
    expect(ourRoom!.eventCount).toBe(2);
  });

  // Overlap semantics: a booking that starts before the window and ends
  // after it must still be counted, clamped to the portion inside the window.
  it("roomUtilization counts and clamps a booking that crosses the window boundary", async () => {
    const from = new Date("2026-01-02T00:00:00Z"); // window starts AFTER the crossing booking's start (22:00 on Jan 1)
    const to = new Date("2026-01-02T01:00:00Z"); // window ends BEFORE the crossing booking's end (02:00 on Jan 2)
    const rows = await roomUtilization(from, to);
    const ourRoom = rows.find((r) => r.roomId === createdRoomIds[0]);
    expect(ourRoom).toBeDefined();
    // Only the crossing booking overlaps this window; clamped to [00:00, 01:00) = 1h.
    expect(ourRoom!.eventCount).toBe(1);
    expect(ourRoom!.eventHours).toBe(1);
  });
});
