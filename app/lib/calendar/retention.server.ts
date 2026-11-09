import { db } from "~/lib/db.server";

export async function pruneCompletedCalendarOutbox(cutoff: Date): Promise<number> {
  return db.$executeRaw`
    DELETE FROM "CalendarOutbox" AS o
    WHERE o.status IN ('SENT', 'SUPERSEDED')
      AND (
        (
          NOT EXISTS (SELECT 1 FROM "Event" e WHERE e.uid = o."eventUid")
          AND NOT EXISTS (
            SELECT 1 FROM "CalendarOutbox" a
            WHERE a."eventUid" = o."eventUid" AND a.status IN ('PENDING', 'FAILED')
          )
        )
        OR (
          o."processedAt" < ${cutoff}
          AND o.sequence IS DISTINCT FROM (
            SELECT max(h.sequence) FROM "CalendarOutbox" h WHERE h."eventUid" = o."eventUid"
          )
          AND o.sequence IS DISTINCT FROM (
            SELECT max(s.sequence) FROM "CalendarOutbox" s
            WHERE s."eventUid" = o."eventUid" AND s.status = 'SENT'
          )
          AND o.id IS DISTINCT FROM (
            SELECT g.id FROM "CalendarOutbox" g
            WHERE g.status = 'SENT' AND g."processedAt" IS NOT NULL
              AND (
                EXISTS (SELECT 1 FROM "Event" e WHERE e.uid = g."eventUid")
                OR EXISTS (
                  SELECT 1 FROM "CalendarOutbox" a
                  WHERE a."eventUid" = g."eventUid" AND a.status IN ('PENDING', 'FAILED')
                )
              )
            ORDER BY g."processedAt" DESC, g."eventUid" ASC, g.sequence DESC, g.id ASC
            LIMIT 1
          )
        )
      )`;
}
