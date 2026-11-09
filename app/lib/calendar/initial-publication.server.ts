import { txWithAudit } from "~/lib/audit.server";
import { berlinDayIndex, berlinDayStartMs } from "~/lib/berlin-days";
import { isCalendarConfigured } from "~/lib/calendar/config.server";
import { enqueueEventCalendarOp } from "~/lib/calendar/event-publication.server";
import { DRAIN_LOCK_KEY } from "~/lib/calendar/outbox.server";
import { ENTITY_TYPE } from "~/domains/tickets/tickets.history.server";

export async function initializeCalendarPublication(now = new Date()): Promise<boolean> {
  if (!isCalendarConfigured()) return false;
  return txWithAudit(
    null,
    async (tx, audit) => {
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${DRAIN_LOCK_KEY}, 0)) AS locked`;
      if (!lock?.locked) return false;
      if (await tx.calendarPublicationInitialization.findUnique({ where: { id: "caldav" } })) {
        return true;
      }
      const boundary = new Date(berlinDayStartMs(berlinDayIndex(now)));
      const candidates = await tx.event.findMany({
        where: { endsAt: { gt: boundary } },
        select: { uid: true },
      });
      const pending = await tx.calendarOutbox.findMany({
        where: { status: "PENDING" },
        select: { eventUid: true },
      });
      const uids = [
        ...new Set([
          ...candidates.map((event) => event.uid),
          ...pending.map((row) => row.eventUid),
        ]),
      ].sort();
      for (const uid of uids) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${uid}, 0))`;
      }
      const backlog = await tx.calendarOutbox.findMany({
        where: { eventUid: { in: uids }, status: "PENDING" },
        orderBy: [{ eventUid: "asc" }, { sequence: "asc" }],
      });
      for (const row of backlog) {
        await tx.calendarOutbox.update({
          where: { id: row.id },
          data: { status: "SUPERSEDED", processedAt: now, nextAttemptAt: null },
        });
        await audit({
          action: "CalendarOutboxSuperseded",
          entityType: ENTITY_TYPE.calendarOutbox,
          entityId: row.id,
          data: {
            reason: "first_configured_publication",
            eventUid: row.eventUid,
            sequence: row.sequence,
          },
        });
      }
      const events = await tx.event.findMany({
        where: { uid: { in: uids }, endsAt: { gt: boundary } },
        orderBy: { uid: "asc" },
      });
      for (const event of events) {
        if (event.status === "CANCELLED") {
          const published = await tx.calendarOutbox.findFirst({
            where: {
              eventUid: event.uid,
              op: "UPSERT",
              OR: [{ status: { in: ["SENT", "FAILED"] } }, { attempts: { gt: 0 } }],
            },
            select: { id: true },
          });
          if (!published) continue;
        }
        await enqueueEventCalendarOp(tx, event, event.status === "CANCELLED" ? "REMOVE" : "UPSERT");
        const retryAfter = backlog
          .filter((row) => row.eventUid === event.uid && row.attempts > 0)
          .reduce<Date | null>((latest, row) => {
            const retry = row.nextAttemptAt;
            return retry && retry > now && (!latest || retry > latest) ? retry : latest;
          }, null);
        if (retryAfter) {
          await tx.calendarOutbox.updateMany({
            where: { eventUid: event.uid, status: "PENDING" },
            data: { nextAttemptAt: retryAfter },
          });
        }
        await audit({
          action: "CalendarPublicationInitialized",
          entityType: ENTITY_TYPE.event,
          entityId: event.id,
          data: {
            op: event.status === "CANCELLED" ? "REMOVE" : "UPSERT",
            boundary: boundary.toISOString(),
          },
        });
      }
      await tx.calendarPublicationInitialization.create({ data: { id: "caldav" } });
      return true;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
