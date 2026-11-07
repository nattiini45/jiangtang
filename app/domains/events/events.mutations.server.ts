import { tr } from "~/i18n/request-locale.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import type { Tx } from "~/lib/db.server";
import { BookingConflictError, NotFoundError, ValidationError } from "~/lib/errors.server";
import { insertOrConflict } from "~/lib/booking.server";
import { findEquipmentConflicts, findRoomConflicts } from "./events.availability.server";
import { notifyBookingConflict } from "~/domains/notifications/notifications.mutations.server";
import { enqueueCalendarOp } from "~/lib/calendar/publisher.server";
import { berlinLocalToUtc } from "~/lib/time.server";
import type {
  EquipmentAllocation,
  Event,
  EventRoomBooking,
  ServiceWindow,
} from "~/generated/prisma/client";
import { EquipmentMobility, EquipmentStatus } from "~/generated/prisma/enums";
import type {
  AllocationInput,
  EventCreateInput,
  EventEditInput,
  RoomBookingInput,
  ServiceWindowInput,
} from "./events.schema";

/**
 * Events-domain mutations. Two layers cooperate:
 *  - the no-double-booking invariant is enforced by the DB (GiST EXCLUDE on
 *    EventRoomBooking / EquipmentAllocation); every bookable insert is wrapped in
 *    insertOrConflict so a 23P01 surfaces as a typed BookingConflictError (→ 409);
 *  - calendar publishing is decoupled via a transactional outbox: each event
 *    mutation enqueues an op in the SAME tx (enqueueCalendarOp); the outbox worker
 *    drains it. Everything funnels through txWithAudit (audit in the same tx).
 */

// ── Calendar outbox helpers (transactional-outbox producer side) ──────────────

/**
 * Next monotonic iCal SEQUENCE for an event (the outbox is unique per (uid, seq)).
 * A transaction-scoped advisory lock keyed by the event uid serializes this
 * read-then-write across concurrent mutations on the same event, so two
 * transactions can't both allocate the same sequence and collide on the unique
 * index (which would otherwise surface as an opaque 500). The lock releases on
 * commit/rollback.
 */
async function nextSequence(tx: Tx, eventUid: string): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${eventUid}, 0))`;
  const last = await tx.calendarOutbox.findFirst({
    where: { eventUid },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  return last ? last.sequence + 1 : 0;
}

/** Non-cancelled room names → a human "location" for the calendar payload. */
async function roomLocation(tx: Tx, eventId: string): Promise<string | undefined> {
  const bookings = await tx.eventRoomBooking.findMany({
    where: { eventId, cancelled: false },
    include: { room: { select: { name: true } } },
  });
  const names = [...new Set(bookings.map((b) => b.room.name))];
  return names.length ? names.join(", ") : undefined;
}

async function enqueueUpsert(tx: Tx, event: Event): Promise<void> {
  const sequence = await nextSequence(tx, event.uid);
  await enqueueCalendarOp(tx, {
    op: "UPSERT",
    eventUid: event.uid,
    sequence,
    payload: {
      uid: event.uid,
      title: event.title,
      description: event.description ?? undefined,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      location: await roomLocation(tx, event.id),
      timezone: "Europe/Berlin",
      sequence,
    },
  });
}

async function enqueueRemove(tx: Tx, event: Event): Promise<void> {
  const sequence = await nextSequence(tx, event.uid);
  await enqueueCalendarOp(tx, {
    op: "REMOVE",
    eventUid: event.uid,
    sequence,
    payload: {
      uid: event.uid,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      timezone: "Europe/Berlin",
      sequence,
    },
  });
}

/** Re-publish an event's calendar entry after its room set changed (the payload's
 *  location is derived from the rooms), unless the event is cancelled. */
async function reenqueueEvent(tx: Tx, eventId: string): Promise<void> {
  const event = await tx.event.findUnique({ where: { id: eventId } });
  if (event && event.status !== "CANCELLED") await enqueueUpsert(tx, event);
}

/** Guard for the add* mutations below: an event's child rows (bookings,
 *  allocations, service windows) can't be attached once the event is
 *  CANCELLED (terminal) — throws NotFoundError if the event itself doesn't
 *  exist so a stale eventId behaves like the P2025 → 404 path elsewhere. */
async function assertEventMutable(tx: Tx, eventId: string): Promise<void> {
  const event = await tx.event.findUnique({ where: { id: eventId }, select: { status: true } });
  if (!event) throw new NotFoundError(tr("work.err.event.notFound"));
  if (event.status === "CANCELLED") {
    throw new ValidationError({
      eventId: [tr("work.err.event.cancelled")],
    });
  }
}

/** Cancel every active booking + allocation of an event (freeing their EXCLUDE
 *  slots). Returns the freed counts for the audit payload. Sequential, not
 *  Promise.all: Prisma interactive transactions hold a single reserved
 *  connection, so concurrent queries on the same tx client are unsafe. */
async function freeEventSlots(
  tx: Tx,
  eventId: string,
): Promise<{ rooms: number; equipment: number }> {
  const rooms = await tx.eventRoomBooking.updateMany({
    where: { eventId, cancelled: false },
    data: { cancelled: true },
  });
  const equipment = await tx.equipmentAllocation.updateMany({
    where: { eventId, cancelled: false },
    data: { cancelled: true },
  });
  return { rooms: rooms.count, equipment: equipment.count };
}

// ── Event lifecycle ────────────────────────────────────────────────────────

export async function createEvent(actor: AuditActor, input: EventCreateInput): Promise<Event> {
  return txWithAudit(actor, async (tx, audit) => {
    const event = await tx.event.create({
      data: {
        title: input.title,
        description: input.description ?? null,
        startsAt: berlinLocalToUtc(input.startsAt),
        endsAt: berlinLocalToUtc(input.endsAt),
        status: input.status,
        organizer: input.organizer ?? null,
        contact: input.contact ?? null,
      },
    });
    await audit({
      action: "EventCreated",
      entityType: "event",
      entityId: event.id,
      data: { title: event.title },
    });
    await enqueueUpsert(tx, event);
    return event;
  });
}

export async function updateEvent(
  actor: AuditActor,
  id: string,
  input: EventEditInput,
): Promise<Event> {
  return txWithAudit(actor, async (tx, audit) => {
    const event = await tx.event.update({
      where: { id },
      data: {
        title: input.title,
        description: input.description ?? null,
        startsAt: berlinLocalToUtc(input.startsAt),
        endsAt: berlinLocalToUtc(input.endsAt),
        status: input.status,
        organizer: input.organizer ?? null,
        contact: input.contact ?? null,
      },
    });
    await audit({ action: "EventUpdated", entityType: "event", entityId: event.id });
    // Editing the status to CANCELLED must release slots + enqueue a REMOVE, the
    // same as the dedicated cancel path — otherwise the bookings keep their slots.
    if (event.status === "CANCELLED") {
      const freed = await freeEventSlots(tx, id);
      await audit({
        action: "EventCancelled",
        entityType: "event",
        entityId: event.id,
        data: { ...freed, viaEdit: true },
      });
      await enqueueRemove(tx, event);
    } else {
      await enqueueUpsert(tx, event);
    }
    return event;
  });
}

/**
 * Cancel an event (never hard-delete — preserves history + audit). Frees its
 * slots by cancelling every room booking and allocation, then enqueues a calendar
 * REMOVE. Idempotent: an already-cancelled event is returned untouched (no
 * duplicate REMOVE or audit row).
 */
export async function cancelEvent(actor: AuditActor, id: string): Promise<Event> {
  return txWithAudit(actor, async (tx, audit) => {
    const existing = await tx.event.findUnique({ where: { id }, select: { status: true } });
    if (!existing) throw new NotFoundError(tr("work.err.event.notFound"));
    if (existing.status === "CANCELLED") return tx.event.findUniqueOrThrow({ where: { id } });

    const freed = await freeEventSlots(tx, id);
    const event = await tx.event.update({ where: { id }, data: { status: "CANCELLED" } });
    await audit({ action: "EventCancelled", entityType: "event", entityId: event.id, data: freed });
    await enqueueRemove(tx, event);
    return event;
  });
}

// ── Room bookings (conflict-guarded) ─────────────────────────────────────────

export async function addRoomBooking(
  actor: AuditActor,
  eventId: string,
  input: RoomBookingInput,
): Promise<EventRoomBooking> {
  const startsAt = berlinLocalToUtc(input.startsAt);
  const endsAt = berlinLocalToUtc(input.endsAt);
  try {
    return await txWithAudit(actor, async (tx, audit) => {
      await assertEventMutable(tx, eventId);
      const booking = await insertOrConflict(
        () =>
          tx.eventRoomBooking.create({ data: { eventId, roomId: input.roomId, startsAt, endsAt } }),
        tr("work.err.event.roomAlreadyBooked"),
      );
      await audit({
        action: "RoomBooked",
        entityType: "eventRoomBooking",
        entityId: booking.id,
        data: { roomId: input.roomId },
      });
      await reenqueueEvent(tx, eventId); // calendar location is derived from the room set
      return booking;
    });
  } catch (e) {
    // The EXCLUDE constraint fired: the booking rolled back, but the owner of
    // the conflicting booking gets an inbox row (separate transaction — the
    // failed one is gone by now). The DB remains the authority; this is the
    // notification, not a second check.
    if (e instanceof BookingConflictError) {
      // The notification must never mask the original 409: if the follow-up
      // itself fails, the client still gets the conflict error.
      try {
        const conflicts = await findRoomConflicts(input.roomId, startsAt, endsAt);
        await notifyBookingConflict({
          actor,
          entityType: "eventRoomBooking",
          entityId: eventId,
          conflictingEventIds: conflicts.map((c) => c.eventId),
          detail: {
            roomId: input.roomId,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            conflicts: conflicts.map((c) => ({ eventId: c.eventId, eventTitle: c.eventTitle })),
          },
        });
      } catch (notifyError) {
        console.error(
          "[events] booking-conflict notification failed:",
          (notifyError as Error).message,
        );
      }
    }
    throw e;
  }
}

/** Scoped to eventId (not just the row id) so a POST against a different
 *  event's URL can't cancel a booking that belongs to another event
 *  (IDOR-class — the route only ever knows its own params.id). */
export async function cancelRoomBooking(
  actor: AuditActor,
  bookingId: string,
  eventId: string,
): Promise<EventRoomBooking> {
  return txWithAudit(actor, async (tx, audit) => {
    const result = await tx.eventRoomBooking.updateMany({
      where: { id: bookingId, eventId },
      data: { cancelled: true },
    });
    if (result.count === 0) throw new NotFoundError(tr("work.err.event.roomBookingNotFound"));
    const booking = await tx.eventRoomBooking.findUniqueOrThrow({ where: { id: bookingId } });
    await audit({
      action: "RoomBookingCancelled",
      entityType: "eventRoomBooking",
      entityId: booking.id,
    });
    await reenqueueEvent(tx, booking.eventId);
    return booking;
  });
}

// ── Pooled-equipment allocations (conflict-guarded) ───────────────────────────

export async function addAllocation(
  actor: AuditActor,
  eventId: string,
  input: AllocationInput,
): Promise<EquipmentAllocation> {
  const startsAt = berlinLocalToUtc(input.startsAt);
  const endsAt = berlinLocalToUtc(input.endsAt);
  try {
    return await txWithAudit(actor, async (tx, audit) => {
      await assertEventMutable(tx, eventId);
      // Only POOLED equipment is mobile enough to allocate to an event — the UI
      // picker filters to POOLED (and out RETIRED) already, but that's client-side
      // only, so a crafted POST could otherwise attach FIXED (room-mounted) or
      // RETIRED (terminal "do not use") equipment.
      const equipment = await tx.equipment.findUnique({
        where: { id: input.equipmentId },
        select: { mobility: true, status: true },
      });
      if (!equipment) throw new NotFoundError(tr("work.err.event.equipmentNotFound"));
      if (equipment.mobility !== EquipmentMobility.POOLED) {
        throw new ValidationError({
          equipmentId: [tr("work.err.event.onlyPooled")],
        });
      }
      if (equipment.status === EquipmentStatus.RETIRED) {
        throw new ValidationError({
          equipmentId: [tr("work.err.event.retiredEquipment")],
        });
      }
      const allocation = await insertOrConflict(
        () =>
          tx.equipmentAllocation.create({
            data: { eventId, equipmentId: input.equipmentId, startsAt, endsAt },
          }),
        tr("work.err.event.equipmentAlreadyAllocated"),
      );
      await audit({
        action: "EquipmentAllocated",
        entityType: "equipmentAllocation",
        entityId: allocation.id,
        data: { equipmentId: input.equipmentId },
      });
      return allocation;
    });
  } catch (e) {
    if (e instanceof BookingConflictError) {
      try {
        const conflicts = await findEquipmentConflicts(input.equipmentId, startsAt, endsAt);
        await notifyBookingConflict({
          actor,
          entityType: "equipmentAllocation",
          entityId: eventId,
          conflictingEventIds: conflicts.map((c) => c.eventId),
          detail: {
            equipmentId: input.equipmentId,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            conflicts: conflicts.map((c) => ({ eventId: c.eventId, eventTitle: c.eventTitle })),
          },
        });
      } catch (notifyError) {
        console.error(
          "[events] booking-conflict notification failed:",
          (notifyError as Error).message,
        );
      }
    }
    throw e;
  }
}

/** Scoped to eventId — see cancelRoomBooking for the IDOR rationale. */
export async function cancelAllocation(
  actor: AuditActor,
  allocationId: string,
  eventId: string,
): Promise<EquipmentAllocation> {
  return txWithAudit(actor, async (tx, audit) => {
    const result = await tx.equipmentAllocation.updateMany({
      where: { id: allocationId, eventId },
      data: { cancelled: true },
    });
    if (result.count === 0) throw new NotFoundError(tr("work.err.event.allocationNotFound"));
    const allocation = await tx.equipmentAllocation.findUniqueOrThrow({
      where: { id: allocationId },
    });
    await audit({
      action: "EquipmentDeallocated",
      entityType: "equipmentAllocation",
      entityId: allocation.id,
    });
    return allocation;
  });
}

// ── Service windows (setup / standby / teardown) ──────────────────────────────

export async function addServiceWindow(
  actor: AuditActor,
  eventId: string,
  input: ServiceWindowInput,
): Promise<ServiceWindow> {
  return txWithAudit(actor, async (tx, audit) => {
    await assertEventMutable(tx, eventId);
    const sw = await tx.serviceWindow.create({
      data: {
        eventId,
        roomId: input.roomId ?? null,
        kind: input.kind,
        startsAt: berlinLocalToUtc(input.startsAt),
        endsAt: berlinLocalToUtc(input.endsAt),
        coveringUserId: input.coveringUserId ?? null,
        notes: input.notes ?? null,
      },
    });
    await audit({
      action: "ServiceWindowAdded",
      entityType: "serviceWindow",
      entityId: sw.id,
      data: { kind: input.kind },
    });
    return sw;
  });
}

/** Scoped to eventId — see cancelRoomBooking for the IDOR rationale. Unlike
 *  cancelRoomBooking/cancelAllocation (soft-cancel, row stays queryable), this
 *  hard-deletes the row — so the audit entry snapshots its meaningful fields
 *  first, otherwise the removal would be untraceable. */
export async function removeServiceWindow(
  actor: AuditActor,
  id: string,
  eventId: string,
): Promise<void> {
  await txWithAudit(actor, async (tx, audit) => {
    const sw = await tx.serviceWindow.findFirst({ where: { id, eventId } });
    if (!sw) throw new NotFoundError(tr("work.err.event.serviceWindowNotFound"));
    await tx.serviceWindow.delete({ where: { id } });
    await audit({
      action: "ServiceWindowRemoved",
      entityType: "serviceWindow",
      entityId: id,
      data: {
        roomId: sw.roomId,
        kind: sw.kind,
        startsAt: sw.startsAt,
        endsAt: sw.endsAt,
        coveringUserId: sw.coveringUserId,
        notes: sw.notes,
      },
    });
  });
}
