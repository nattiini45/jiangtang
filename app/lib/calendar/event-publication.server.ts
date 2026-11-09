import type { Event } from "~/generated/prisma/client";
import type { Tx } from "~/lib/db.server";
import { isCalendarConfigured } from "~/lib/calendar/config.server";
import { enqueueCalendarOp, type CalendarOp } from "~/lib/calendar/publisher.server";

export async function enqueueEventCalendarOp(tx: Tx, event: Event, op: CalendarOp): Promise<void> {
  if (!isCalendarConfigured()) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${event.uid}, 0))`;
  const last = await tx.calendarOutbox.findFirst({
    where: { eventUid: event.uid },
    orderBy: { sequence: "desc" },
    select: { sequence: true },
  });
  const sequence = last ? last.sequence + 1 : 0;
  const bookings =
    op === "UPSERT"
      ? await tx.eventRoomBooking.findMany({
          where: { eventId: event.id, cancelled: false },
          include: { room: { select: { name: true } } },
        })
      : [];
  const names = [...new Set(bookings.map((booking) => booking.room.name))];
  await enqueueCalendarOp(tx, {
    op,
    eventUid: event.uid,
    sequence,
    payload: {
      uid: event.uid,
      title: event.title,
      ...(op === "UPSERT" ? { description: event.description ?? undefined } : {}),
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      ...(names.length ? { location: names.join(", ") } : {}),
      timezone: "Europe/Berlin",
      sequence,
    },
  });
}
