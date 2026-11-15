import { db } from "~/lib/db.server";
import {
  decodeActivityCursor,
  encodeActivityCursor,
} from "~/domains/activity/activity.queries.server";

export async function listHomeChanges(cursor?: string, limit = 50) {
  const before = decodeActivityCursor(cursor);
  const rows = await db.$queryRaw<
    { id: string; action: string; occurredAt: Date; title: string; href: string }[]
  >`
    SELECT * FROM (
      SELECT a.id, a.action, a."occurredAt", COALESCE(t.title, r.name) AS title,
        CASE WHEN t.id IS NOT NULL THEN '/tickets/' || t.id
          ELSE '/rooms/' || r.slug END AS href
      FROM "ActivityLog" a
      LEFT JOIN "Ticket" t ON a."entityType" = 'ticket' AND a."entityId" = t.id
      LEFT JOIN "Room" r ON a."entityType" = 'room' AND a."entityId" = r.id
      WHERE (t.type = 'INCIDENT' AND a.action IN ('TicketCreated', 'TicketResolved', 'TicketReopened', 'TicketCancelled'))
        OR (r.id IS NOT NULL AND a.action IN ('FunctionStateSet', 'FunctionStateCleared'))
      UNION ALL
      SELECT id, 'HomeRoundFinished' AS action, "closedAt" AS "occurredAt", name AS title,
        '/rounds/' || id AS href FROM "Round" WHERE "closedAt" IS NOT NULL
    ) changes
    WHERE ${!before} OR ("occurredAt", id) < (${before?.occurredAt ?? new Date(0)}, ${before?.id ?? ""})
    ORDER BY "occurredAt" DESC, id DESC LIMIT ${limit + 1}
  `;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeActivityCursor(last.occurredAt, last.id) : null,
  };
}
