import { tr } from "~/i18n/request-locale.server";
import type { EventSeries } from "~/generated/prisma/client";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { insertOrConflict } from "~/lib/booking.server";
import { enqueueEventCalendarOp } from "~/lib/calendar/event-publication.server";
import { db, type Tx } from "~/lib/db.server";
import { BookingConflictError, NotFoundError, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { occurrenceTimes, seriesDates, seriesHorizon } from "./event-series.dates.server";
import { lockEventSeries } from "./event-series.link.server";
import { eventSeriesSchema, type EventSeriesInput } from "./event-series.schema";
import {
  equipmentBookingHealthOverride,
  roomBookingHealthOverride,
} from "./events.health-policy.server";
import { cancelEventInTx, moveEventServiceWindows } from "./events.mutations.server";

const options = { timeout: 60_000 };

async function checkResources(tx: Tx, definition: EventSeriesInput) {
  const rooms = [];
  const equipment = [];
  for (const input of [...definition.rooms].sort((a, b) => a.roomId.localeCompare(b.roomId))) {
    rooms.push({
      roomId: input.roomId,
      audit: await roomBookingHealthOverride(tx, input.roomId, input),
    });
  }
  for (const input of [...definition.equipment].sort((a, b) =>
    a.equipmentId.localeCompare(b.equipmentId),
  )) {
    equipment.push({
      equipmentId: input.equipmentId,
      audit: await equipmentBookingHealthOverride(tx, input),
    });
  }
  return { rooms, equipment };
}

async function materialize(
  tx: Tx,
  audit: AuditFn,
  series: EventSeries,
  definition: EventSeriesInput,
  from: string,
  through: string,
  { replacing = new Map<string, string>(), skipUnavailable = false } = {},
) {
  const resources = await checkResources(tx, definition).catch((error: unknown) => {
    if (!skipUnavailable) throw error;
    if (error instanceof NotFoundError) return { blocked: error.message };
    if (!(error instanceof ValidationError)) throw error;
    return {
      blocked:
        error.formErrors[0] ?? Object.values(error.fieldErrors).flat()[0] ?? tr("err.invalidInput"),
    };
  });
  if (replacing.size) {
    const where = { eventId: { in: [...replacing.values()] }, cancelled: false };
    await tx.eventRoomBooking.updateMany({ where, data: { cancelled: true } });
    await tx.equipmentAllocation.updateMany({ where, data: { cancelled: true } });
  }
  const eventIds: string[] = [];
  const conflicts: { date: string; message: string }[] = [];
  const cancelledIds: string[] = [];
  const exceptions = new Set([...series.exceptions, ...series.conflictDates]);
  let nextDate: string | null = null;
  for (const date of seriesDates(definition)) {
    if (series.stopsBefore && date >= series.stopsBefore) break;
    if (date < from || exceptions.has(date)) continue;
    if (date > through) {
      nextDate = date;
      break;
    }
    if ("blocked" in resources) {
      conflicts.push({ date, message: resources.blocked });
      continue;
    }
    const previousId = replacing.get(date);
    await tx.$executeRaw`SAVEPOINT series_occurrence`;
    try {
      const times = occurrenceTimes(definition.event, date);
      const { title, description, status, organizer, contact } = definition.event;
      const data = {
        ...times,
        title,
        status,
        description: description ?? null,
        organizer: organizer ?? null,
        contact: contact ?? null,
        seriesId: series.id,
        occurrenceKey: date,
      };
      const previous = previousId
        ? await tx.event.findUniqueOrThrow({ where: { id: previousId } })
        : null;
      const event = previousId
        ? await tx.event.update({ where: { id: previousId }, data })
        : await tx.event.create({ data });
      if (previous) await moveEventServiceWindows(tx, previous, event);
      await audit({
        entityType: "event",
        entityId: event.id,
        action: previousId ? "EventUpdated" : "EventCreated",
        data: { title, seriesId: series.id, date },
      });
      for (const { roomId, audit: health } of resources.rooms) {
        const row = await insertOrConflict(
          () => tx.eventRoomBooking.create({ data: { roomId, eventId: event.id, ...times } }),
          tr("work.err.event.roomAlreadyBooked"),
        );
        await audit({
          entityType: "eventRoomBooking",
          entityId: row.id,
          action: "RoomBooked",
          data: { roomId, ...health },
        });
      }
      for (const { equipmentId, audit: health } of resources.equipment) {
        const row = await insertOrConflict(
          () =>
            tx.equipmentAllocation.create({ data: { equipmentId, eventId: event.id, ...times } }),
          tr("work.err.event.equipmentAlreadyAllocated"),
        );
        await audit({
          entityType: "equipmentAllocation",
          entityId: row.id,
          action: "EquipmentAllocated",
          data: { equipmentId, ...health },
        });
      }
      await enqueueEventCalendarOp(tx, event, "UPSERT");
      eventIds.push(event.id);
    } catch (error) {
      if (!(error instanceof BookingConflictError)) throw error;
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT series_occurrence`;
      conflicts.push({ date, message: error.message });
      if (previousId) {
        await cancelEventInTx(tx, audit, previousId);
        cancelledIds.push(previousId);
      }
    }
    await tx.$executeRaw`RELEASE SAVEPOINT series_occurrence`;
  }
  await tx.eventSeries.update({
    where: { id: series.id },
    data: { nextDate, conflictDates: { push: conflicts.map(({ date }) => date) } },
  });
  return { seriesId: series.id, eventIds, conflicts, cancelledIds };
}

async function emitEvents(ids: string[], op: "created" | "updated") {
  for (const id of ids) await emitChange({ entityType: "event", id, op });
}

export async function createEventSeries(
  actor: AuditActor,
  input: EventSeriesInput,
  now = new Date(),
) {
  const result = await txWithAudit(
    actor,
    async (tx, audit) => {
      const series = await tx.eventSeries.create({ data: { definition: input } });
      await audit({
        entityType: "eventSeries",
        entityId: series.id,
        action: "EventSeriesCreated",
        data: { title: input.event.title },
      });
      return materialize(tx, audit, series, input, seriesHorizon(now, -366), seriesHorizon(now));
    },
    options,
  );
  await emitEvents(result.eventIds, "created");
  await emitChange({ entityType: "eventSeries", id: result.seriesId, op: "created" });
  return result;
}

export async function extendEventSeries(id: string, now = new Date()) {
  const horizon = seriesHorizon(now);
  const result = await txWithAudit(
    null,
    async (tx, audit) => {
      const series = await lockEventSeries(tx, id);
      if (!series.nextDate || series.nextDate > horizon) return;
      const floor = seriesHorizon(now, -366);
      const result = await materialize(
        tx,
        audit,
        series,
        eventSeriesSchema.parse(series.definition),
        series.nextDate > floor ? series.nextDate : floor,
        horizon,
        { skipUnavailable: true },
      );
      await audit({
        entityType: "eventSeries",
        entityId: id,
        action: "EventSeriesExtended",
        data: { through: horizon, conflicts: result.conflicts.map(({ date }) => date) },
      });
      return result;
    },
    options,
  );
  if (result) {
    await emitEvents(result.eventIds, "created");
    await emitChange({ entityType: "eventSeries", id, op: "updated" });
  }
  return result;
}

export async function changeEventSeries(
  actor: AuditActor,
  id: string,
  date: string,
  event: EventSeriesInput["event"] | null,
  now = new Date(),
) {
  const result = await txWithAudit(
    actor,
    async (tx, audit) => {
      const series = await lockEventSeries(tx, id);
      const definition = eventSeriesSchema.parse(series.definition);
      let before = 0;
      let found = false;
      for (const key of seriesDates(definition)) {
        if (key > date || (series.stopsBefore && key >= series.stopsBefore)) break;
        if (key === date) {
          found = true;
          break;
        }
        before++;
      }
      if (!found || (event && event.startsAt.slice(0, 10) !== date)) {
        throw new ValidationError({ startsAt: [tr("work.err.event.seriesDate")] });
      }
      const following = await tx.event.findMany({
        where: { seriesId: id, occurrenceKey: { gte: date }, status: { not: "CANCELLED" } },
        select: { id: true, occurrenceKey: true },
        orderBy: { occurrenceKey: "asc" },
      });
      await tx.eventSeries.update({
        where: { id },
        data: {
          stopsBefore: date,
          nextDate: series.nextDate && series.nextDate < date ? series.nextDate : null,
          conflictDates: series.conflictDates.filter((key) => key < date),
        },
      });
      await audit({
        entityType: "eventSeries",
        entityId: id,
        action: event ? "EventSeriesSplit" : "EventSeriesCancelled",
        data: { date },
      });
      if (!event) {
        for (const occurrence of following) await cancelEventInTx(tx, audit, occurrence.id);
        return {
          seriesId: id,
          eventIds: [],
          conflicts: [],
          cancelledIds: following.map(({ id }) => id),
        };
      }
      const input = {
        ...definition,
        event,
        end:
          definition.end.kind === "count"
            ? { ...definition.end, count: definition.end.count - before }
            : definition.end,
      };
      const next = await tx.eventSeries.create({
        data: {
          definition: input,
          stopsBefore: series.stopsBefore,
          exceptions: series.exceptions.filter((key) => key >= date),
          conflictDates: series.conflictDates.filter((key) => key >= date),
        },
      });
      const replacing = new Map(
        following.flatMap(({ id, occurrenceKey }) => (occurrenceKey ? [[occurrenceKey, id]] : [])),
      );
      const horizon = seriesHorizon(now);
      const through = following.at(-1)?.occurrenceKey ?? horizon;
      const floor = seriesHorizon(now, -366);
      const first = following[0]?.occurrenceKey;
      const oldest = first && first < floor ? first : floor;
      return materialize(
        tx,
        audit,
        next,
        input,
        date > oldest ? date : oldest,
        through > horizon ? through : horizon,
        { replacing },
      );
    },
    options,
  );
  await emitEvents([...result.eventIds, ...result.cancelledIds], "updated");
  await emitChange({ entityType: "eventSeries", id, op: "updated" });
  if (id !== result.seriesId) {
    await emitChange({ entityType: "eventSeries", id: result.seriesId, op: "created" });
  }
  return result;
}

export async function dueEventSeries(now: Date) {
  return db.eventSeries.findMany({
    where: { nextDate: { lte: seriesHorizon(now) } },
    select: { id: true },
  });
}
