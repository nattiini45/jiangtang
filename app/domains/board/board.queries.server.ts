import { Prisma } from "~/generated/prisma/client";
import type { TicketStatus, TicketType } from "~/generated/prisma/client";
import { db } from "~/lib/db.server";
import { LANES, laneOfTicketStatus, type Lane } from "~/domains/tasks/tasks.lanes";

/**
 * Board-domain queries — query-only folder, owns no model
 * (`cross-folder-writes` FOLDERS `[]`).
 *
 * `listWorkTickets` lists tickets **through the `workitem` view** — the lane,
 * `sort_priority`, `assignee_ids` and `updated_at` all come from the view's
 * UNION, so a re-mapped `workitem_lane` row changes what the board shows
 * without this file knowing. The view is not in the Prisma schema (hand-folded
 * SQL), so the read is `$queryRaw`. A follow-up Prisma read then fetches
 * what the view deliberately does not project (type, room, real assignee rows,
 * the primary task for the project filter).
 */

interface WorkitemRow {
  id: string;
  lane: string | null;
  sort_priority: number | null;
  updated_at: Date;
}

export interface WorkTicket {
  id: string;
  /** Short mono id for the card — `#` + last 6 (the frequency-board convention). */
  shortId: string;
  title: string;
  type: TicketType;
  status: TicketStatus;
  priority: number | null;
  lane: Lane;
  room: { slug: string; name: string; roomNumber: string | null } | null;
  assignees: Array<{ id: string; name: string; initials: string | null }>;
}

/**
 * `listWorkTickets({ projectId?, assigneeId? })` — tickets in board order:
 * lane index, then `sort_priority ASC NULLS LAST`, then `updated_at DESC`
 * (the documented rule; the view carries no ORDER BY of its own).
 *
 * `projectId` keeps only tickets whose PRIMARY task (`Ticket.taskId`) belongs
 * to that project — the view's `project_id` is NULL for tickets, so the filter
 * applies after the detail read. `assigneeId` filters in SQL on the view's
 * `assignee_ids` array.
 */
export async function listWorkTickets(options: { projectId?: string; assigneeId?: string } = {}) {
  const rows = await db.$queryRaw<WorkitemRow[]>(
    options.assigneeId
      ? Prisma.sql`SELECT id, lane, sort_priority, updated_at FROM "workitem"
                   WHERE kind = 'TICKET' AND ${options.assigneeId} = ANY(assignee_ids)
                   ORDER BY sort_priority ASC NULLS LAST, updated_at DESC`
      : Prisma.sql`SELECT id, lane, sort_priority, updated_at FROM "workitem"
                   WHERE kind = 'TICKET'
                   ORDER BY sort_priority ASC NULLS LAST, updated_at DESC`,
  );
  if (rows.length === 0) return [] as WorkTicket[];

  const tickets = await db.ticket.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      priority: true,
      room: { select: { slug: true, name: true, roomNumber: true } },
      assignees: { select: { id: true, name: true, initials: true } },
      task: { select: { projectId: true } },
    },
  });
  const byId = new Map(tickets.map((t) => [t.id, t]));

  const out: WorkTicket[] = [];
  for (const row of rows) {
    const t = byId.get(row.id);
    if (!t) continue;
    if (options.projectId && t.task?.projectId !== options.projectId) continue;
    // The view's lane is authoritative — a status with no mapping row yields
    // NULL there, and the workitem-view test owns that failure; fall back to
    // the TS mirror only so a NULL lane cannot crash the board render.
    const lane = (row.lane as Lane | null) ?? laneOfTicketStatus(t.status);
    out.push({
      id: t.id,
      shortId: `#${t.id.slice(-6)}`,
      title: t.title,
      type: t.type,
      status: t.status,
      priority: t.priority,
      lane,
      room: t.room,
      assignees: t.assignees,
    });
  }
  // SQL already ordered within a lane; lift lane index to the primary key.
  return out.sort((a, b) => LANES.indexOf(a.lane) - LANES.indexOf(b.lane));
}
