import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { BookingConflictError, NotFoundError, ValidationError } from "~/lib/errors.server";
import {
  addAllocation,
  addRoomBooking,
  addServiceWindow,
  cancelEvent,
  cancelRoomBooking,
  createEvent,
  removeServiceWindow,
  updateEvent,
} from "~/domains/events/events.mutations.server";
import type { EventCreateInput } from "~/domains/events/events.schema";

/**
 * Events mutation guards: event create writes an audit row + a calendar-outbox
 * UPSERT (transactional outbox); the DB no-double-booking invariant surfaces as a
 * typed BookingConflictError via insertOrConflict; half-open [) windows allow
 * back-to-back; cancelling frees the slot; cancelEvent releases bookings + enqueues
 * a REMOVE. Distinct dates per test keep the shared room/equipment independent.
 * Cleanup deletes bookings/allocations/windows, then events, then the outbox +
 * fixtures (Event's children are onDelete: Restrict, not Cascade — child rows
 * must go first); ActivityLog is append-only.
 */

const RUN = `evt_${Date.now()}`;
const actor = { id: null as string | null, name: "Event Tester", initials: "ET" };

const fixtures = {
  campusId: "",
  roomId: "",
  modelId: "",
  equipId: "",
  fixedEquipId: "",
  retiredEquipId: "",
};
const eventIds: string[] = [];
const eventUids: string[] = [];

beforeAll(async () => {
  const campus = await db.campus.create({ data: { name: `${RUN}-Campus`, slug: `${RUN}-campus` } });
  fixtures.campusId = campus.id;
  const room = await db.room.create({
    data: {
      slug: `${RUN}-room`,
      name: `${RUN} Saal`,
      status: "ALL_GOOD",
      hasProjector: false,
      hasMicrophony: false,
      hasBlackboard: false,
      hasWebConference: false,
      hasAutoRecording: false,
      mediaKeyRequired: false,
      campusId: campus.id,
    },
  });
  fixtures.roomId = room.id;
  const model = await db.equipmentModel.create({
    data: { name: `${RUN} Beamer`, category: "PROJECTOR" },
  });
  fixtures.modelId = model.id;
  const equip = await db.equipment.create({
    data: { category: "PROJECTOR", status: "OPERATIONAL", mobility: "POOLED", modelId: model.id },
  });
  fixtures.equipId = equip.id;
  const fixedEquip = await db.equipment.create({
    data: {
      category: "PROJECTOR",
      status: "OPERATIONAL",
      mobility: "FIXED",
      modelId: model.id,
      roomId: room.id,
    },
  });
  fixtures.fixedEquipId = fixedEquip.id;
  // A POOLED unit in the terminal RETIRED state — mobile, but must not be allocatable.
  const retiredEquip = await db.equipment.create({
    data: { category: "PROJECTOR", status: "RETIRED", mobility: "POOLED", modelId: model.id },
  });
  fixtures.retiredEquipId = retiredEquip.id;
});

afterAll(async () => {
  await db.calendarOutbox.deleteMany({ where: { eventUid: { in: eventUids } } });
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.equipmentAllocation.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.serviceWindow.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.equipment.deleteMany({
    where: { id: { in: [fixtures.equipId, fixtures.fixedEquipId, fixtures.retiredEquipId] } },
  });
  await db.equipmentModel.deleteMany({ where: { id: fixtures.modelId } });
  await db.room.deleteMany({ where: { id: fixtures.roomId } });
  await db.campus.deleteMany({ where: { id: fixtures.campusId } });
  await db.$disconnect();
});

function eventInput(start: string, end: string, title = `${RUN} Event`): EventCreateInput {
  return {
    title,
    description: undefined,
    startsAt: start,
    endsAt: end,
    status: "PLANNED",
    organizer: undefined,
    contact: undefined,
  };
}

async function makeEvent(
  start: string,
  end: string,
  title?: string,
): Promise<{ id: string; uid: string }> {
  const ev = await createEvent(actor, eventInput(start, end, title));
  eventIds.push(ev.id);
  eventUids.push(ev.uid);
  return { id: ev.id, uid: ev.uid };
}

describe("event mutations", () => {
  it("creates an event with an audit row and a calendar-outbox UPSERT (seq 0)", async () => {
    const ev = await makeEvent("2026-07-01T08:00", "2026-07-01T20:00");

    const logs = await db.activityLog.findMany({
      where: { entityType: "event", entityId: ev.id, action: "EventCreated" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorSnapshot).toMatchObject({ initials: "ET" });

    const outbox = await db.calendarOutbox.findMany({ where: { eventUid: ev.uid } });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].op).toBe("UPSERT");
    expect(outbox[0].sequence).toBe(0);
    expect(outbox[0].status).toBe("PENDING");
  });

  it("rejects an overlapping room booking with a BookingConflictError", async () => {
    const a = await makeEvent("2026-07-02T08:00", "2026-07-02T20:00");
    const b = await makeEvent("2026-07-02T08:00", "2026-07-02T20:00");

    await addRoomBooking(actor, a.id, {
      roomId: fixtures.roomId,
      startsAt: "2026-07-02T10:00",
      endsAt: "2026-07-02T12:00",
    });
    await expect(
      addRoomBooking(actor, b.id, {
        roomId: fixtures.roomId,
        startsAt: "2026-07-02T11:00",
        endsAt: "2026-07-02T13:00",
      }),
    ).rejects.toBeInstanceOf(BookingConflictError);
  });

  it("allows a back-to-back booking that only touches (half-open ranges)", async () => {
    const a = await makeEvent("2026-07-03T08:00", "2026-07-03T20:00");
    const b = await makeEvent("2026-07-03T08:00", "2026-07-03T20:00");

    await addRoomBooking(actor, a.id, {
      roomId: fixtures.roomId,
      startsAt: "2026-07-03T10:00",
      endsAt: "2026-07-03T12:00",
    });
    const touching = await addRoomBooking(actor, b.id, {
      roomId: fixtures.roomId,
      startsAt: "2026-07-03T12:00",
      endsAt: "2026-07-03T14:00",
    });
    expect(touching.id).toBeTruthy();
  });

  it("frees the slot when a booking is cancelled", async () => {
    const a = await makeEvent("2026-07-04T08:00", "2026-07-04T20:00");
    const b = await makeEvent("2026-07-04T08:00", "2026-07-04T20:00");

    const first = await addRoomBooking(actor, a.id, {
      roomId: fixtures.roomId,
      startsAt: "2026-07-04T10:00",
      endsAt: "2026-07-04T12:00",
    });
    await cancelRoomBooking(actor, first.id, a.id);
    // overlaps the now-cancelled booking — the partial (cancelled=false) predicate exempts it
    const reused = await addRoomBooking(actor, b.id, {
      roomId: fixtures.roomId,
      startsAt: "2026-07-04T11:00",
      endsAt: "2026-07-04T13:00",
    });
    expect(reused.id).toBeTruthy();
  });

  it("rejects an overlapping pooled-equipment allocation", async () => {
    const a = await makeEvent("2026-07-05T08:00", "2026-07-05T20:00");
    const b = await makeEvent("2026-07-05T08:00", "2026-07-05T20:00");

    await addAllocation(actor, a.id, {
      equipmentId: fixtures.equipId,
      startsAt: "2026-07-05T10:00",
      endsAt: "2026-07-05T12:00",
    });
    await expect(
      addAllocation(actor, b.id, {
        equipmentId: fixtures.equipId,
        startsAt: "2026-07-05T11:30",
        endsAt: "2026-07-05T13:00",
      }),
    ).rejects.toBeInstanceOf(BookingConflictError);
  });

  it("cancelling an event releases its bookings and enqueues a calendar REMOVE", async () => {
    const ev = await makeEvent("2026-07-06T08:00", "2026-07-06T20:00");
    await addRoomBooking(actor, ev.id, {
      roomId: fixtures.roomId,
      startsAt: "2026-07-06T10:00",
      endsAt: "2026-07-06T12:00",
    });

    const cancelled = await cancelEvent(actor, ev.id);
    expect(cancelled.status).toBe("CANCELLED");

    const activeBookings = await db.eventRoomBooking.findMany({
      where: { eventId: ev.id, cancelled: false },
    });
    expect(activeBookings).toHaveLength(0);

    const ops = await db.calendarOutbox.findMany({
      where: { eventUid: ev.uid },
      orderBy: { sequence: "asc" },
    });
    expect(ops.map((o) => o.op)).toContain("REMOVE");
    // sequences are monotonic per event
    expect(ops.map((o) => o.sequence)).toEqual([...ops.keys()]);
  });

  it("editing an event status to CANCELLED frees its slots and enqueues a REMOVE", async () => {
    const ev = await makeEvent("2026-07-08T08:00", "2026-07-08T20:00");
    await addRoomBooking(actor, ev.id, {
      roomId: fixtures.roomId,
      startsAt: "2026-07-08T10:00",
      endsAt: "2026-07-08T12:00",
    });

    const updated = await updateEvent(actor, ev.id, {
      ...eventInput("2026-07-08T08:00", "2026-07-08T20:00"),
      status: "CANCELLED",
    });
    expect(updated.status).toBe("CANCELLED");

    const active = await db.eventRoomBooking.findMany({
      where: { eventId: ev.id, cancelled: false },
    });
    expect(active).toHaveLength(0);

    const ops = await db.calendarOutbox.findMany({ where: { eventUid: ev.uid } });
    expect(ops.map((o) => o.op)).toContain("REMOVE");
  });

  it("cancelling an already-cancelled event is idempotent (no duplicate REMOVE or audit)", async () => {
    const ev = await makeEvent("2026-07-09T08:00", "2026-07-09T20:00");
    await cancelEvent(actor, ev.id);
    const outboxAfterFirst = await db.calendarOutbox.count({ where: { eventUid: ev.uid } });

    await cancelEvent(actor, ev.id); // second cancel — must be a no-op
    const outboxAfterSecond = await db.calendarOutbox.count({ where: { eventUid: ev.uid } });
    expect(outboxAfterSecond).toBe(outboxAfterFirst);

    const cancelledLogs = await db.activityLog.count({
      where: { entityType: "event", entityId: ev.id, action: "EventCancelled" },
    });
    expect(cancelledLogs).toBe(1);
  });

  it("adds a service window with an audit row", async () => {
    const ev = await makeEvent("2026-07-07T08:00", "2026-07-07T20:00");
    const w = await addServiceWindow(actor, ev.id, {
      roomId: fixtures.roomId,
      kind: "SETUP",
      startsAt: "2026-07-07T07:00",
      endsAt: "2026-07-07T08:00",
      coveringUserId: undefined,
      notes: "Technik aufbauen",
    });
    expect(w.kind).toBe("SETUP");

    const logs = await db.activityLog.findMany({
      where: { entityType: "serviceWindow", entityId: w.id, action: "ServiceWindowAdded" },
    });
    expect(logs).toHaveLength(1);
  });

  it("rejects cancelling a booking through a different event's id (cross-event IDOR)", async () => {
    const a = await makeEvent("2026-07-10T08:00", "2026-07-10T20:00");
    const b = await makeEvent("2026-07-10T08:00", "2026-07-10T20:00", `${RUN} Event B`);

    const bBooking = await addRoomBooking(actor, b.id, {
      roomId: fixtures.roomId,
      startsAt: "2026-07-10T10:00",
      endsAt: "2026-07-10T12:00",
    });

    // Wrong event (A) in scope — must not cancel B's booking.
    await expect(cancelRoomBooking(actor, bBooking.id, a.id)).rejects.toBeInstanceOf(NotFoundError);
    const stillActive = await db.eventRoomBooking.findUnique({ where: { id: bBooking.id } });
    expect(stillActive?.cancelled).toBe(false);

    // Correct event (B) in scope — succeeds.
    const cancelled = await cancelRoomBooking(actor, bBooking.id, b.id);
    expect(cancelled.cancelled).toBe(true);
  });

  it("rejects attaching a room booking to a cancelled event", async () => {
    const ev = await makeEvent("2026-07-11T08:00", "2026-07-11T20:00");
    await cancelEvent(actor, ev.id);

    await expect(
      addRoomBooking(actor, ev.id, {
        roomId: fixtures.roomId,
        startsAt: "2026-07-11T10:00",
        endsAt: "2026-07-11T12:00",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects allocating FIXED (room-mounted) equipment to an event", async () => {
    const ev = await makeEvent("2026-07-12T08:00", "2026-07-12T20:00");

    await expect(
      addAllocation(actor, ev.id, {
        equipmentId: fixtures.fixedEquipId,
        startsAt: "2026-07-12T10:00",
        endsAt: "2026-07-12T12:00",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const allocations = await db.equipmentAllocation.findMany({ where: { eventId: ev.id } });
    expect(allocations).toHaveLength(0);
  });

  it("rejects allocating a RETIRED pooled unit to an event", async () => {
    const ev = await makeEvent("2026-07-12T08:00", "2026-07-12T20:00");

    await expect(
      addAllocation(actor, ev.id, {
        equipmentId: fixtures.retiredEquipId,
        startsAt: "2026-07-12T14:00",
        endsAt: "2026-07-12T16:00",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const allocations = await db.equipmentAllocation.findMany({ where: { eventId: ev.id } });
    expect(allocations).toHaveLength(0);
  });

  it("removing a service window writes an audit row with a field snapshot", async () => {
    const ev = await makeEvent("2026-07-13T08:00", "2026-07-13T20:00");
    const w = await addServiceWindow(actor, ev.id, {
      roomId: fixtures.roomId,
      kind: "TEARDOWN",
      startsAt: "2026-07-13T20:00",
      endsAt: "2026-07-13T21:00",
      coveringUserId: undefined,
      notes: "Technik abbauen",
    });

    await removeServiceWindow(actor, w.id, ev.id);

    const stillThere = await db.serviceWindow.findUnique({ where: { id: w.id } });
    expect(stillThere).toBeNull();

    const logs = await db.activityLog.findMany({
      where: { entityType: "serviceWindow", entityId: w.id, action: "ServiceWindowRemoved" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].data).toMatchObject({
      roomId: fixtures.roomId,
      kind: "TEARDOWN",
      notes: "Technik abbauen",
    });
    expect(logs[0].data).toHaveProperty("startsAt");
    expect(logs[0].data).toHaveProperty("endsAt");
  });
});
