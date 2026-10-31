import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { insertOrConflict } from "~/lib/booking.server";
import { BookingConflictError } from "~/lib/errors.server";

/**
 * The composition seam: a mutation and its audit row live in ONE transaction.
 * When a conflicting booking raises 23P01 → BookingConflictError, the audit row
 * MUST roll back too (no orphan ActivityLog). And on success, both the mutation
 * and the audit row commit together.
 */

const RUN = `comp_${Date.now()}`;
const ids = { campus: `${RUN}_c`, room: `${RUN}_r`, event: `${RUN}_e` };
const actor = { id: null, name: "Test Actor", initials: "TT" };

// Event window 06:00–18:00Z; an existing committed booking occupies 10:00–12:00Z.
beforeAll(async () => {
  await db.campus.create({ data: { id: ids.campus, name: ids.campus, slug: ids.campus } });
  await db.room.create({ data: { id: ids.room, slug: ids.room, name: "R", campusId: ids.campus } });
  await db.event.create({
    data: {
      id: ids.event,
      uid: ids.event,
      title: "E",
      startsAt: new Date("2026-07-01T06:00:00Z"),
      endsAt: new Date("2026-07-01T18:00:00Z"),
    },
  });
  await db.eventRoomBooking.create({
    data: {
      eventId: ids.event,
      roomId: ids.room,
      startsAt: new Date("2026-07-01T10:00:00Z"),
      endsAt: new Date("2026-07-01T12:00:00Z"),
    },
  });
});

afterAll(async () => {
  // ActivityLog is append-only (cannot be deleted); clean up the rest.
  await db.eventRoomBooking.deleteMany({ where: { roomId: ids.room } });
  await db.event.deleteMany({ where: { id: ids.event } });
  await db.room.deleteMany({ where: { id: ids.room } });
  await db.campus.deleteMany({ where: { id: ids.campus } });
  await db.$disconnect();
});

describe("txWithAudit + insertOrConflict", () => {
  it("rolls back the audit row when the booking conflicts (23P01 → 409)", async () => {
    const marker = `${RUN}_conflict`;

    await expect(
      txWithAudit(actor, async (tx, audit) => {
        // audit FIRST, then the conflicting insert — proves rollback covers the audit.
        await audit({
          action: "EquipmentAllocated",
          entityType: "eventRoomBooking",
          entityId: marker,
        });
        await insertOrConflict(() =>
          tx.eventRoomBooking.create({
            data: {
              eventId: ids.event,
              roomId: ids.room,
              startsAt: new Date("2026-07-01T11:00:00Z"), // overlaps 10–12
              endsAt: new Date("2026-07-01T13:00:00Z"),
            },
          }),
        );
      }),
    ).rejects.toBeInstanceOf(BookingConflictError);

    // The audit row must NOT have been committed.
    const orphan = await db.activityLog.findFirst({ where: { entityId: marker } });
    expect(orphan).toBeNull();
  });

  it("commits the booking and the audit row together on success", async () => {
    const marker = `${RUN}_ok`;

    await txWithAudit(actor, async (tx, audit) => {
      await tx.eventRoomBooking.create({
        data: {
          eventId: ids.event,
          roomId: ids.room,
          startsAt: new Date("2026-07-01T14:00:00Z"), // free window
          endsAt: new Date("2026-07-01T16:00:00Z"),
        },
      });
      await audit({
        action: "EquipmentAllocated",
        entityType: "eventRoomBooking",
        entityId: marker,
      });
    });

    const logged = await db.activityLog.findFirst({ where: { entityId: marker } });
    expect(logged).not.toBeNull();
    expect(logged?.action).toBe("EquipmentAllocated");
    expect(logged?.actorSnapshot).toMatchObject({ name: "Test Actor", initials: "TT" });

    const booking = await db.eventRoomBooking.findFirst({
      where: { roomId: ids.room, startsAt: new Date("2026-07-01T14:00:00Z") },
    });
    expect(booking).not.toBeNull();
  });
});
