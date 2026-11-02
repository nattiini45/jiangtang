import type { TaskStatus, TicketStatus } from "~/generated/prisma/client";

/**
 * The board's lane vocabulary — a **client-safe** module (no `.server`
 * imports; the board UI imports it straight into the browser).
 *
 * This is the TypeScript mirror of the `workitem_lane` TABLE, which is
 * hand-folded SQL (`20261023000500_workitem_view`) and deliberately editable
 * data — not schema. The mirror is a deliberate compromise, and
 * `tasks.lanes.test.ts` enforces it: that test reads the table and
 * asserts this file equals it exactly, so a re-mapped lane row reddens the
 * suite instead of drifting silently.
 *
 * Semantics reminder: `blockedByTaskId = A, blockingTaskId = B` means
 * **A is blocked by B** — B must finish first.
 */

export const LANES = ["BACKLOG", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"] as const;
export type Lane = (typeof LANES)[number];

/** Task.status → lane, mirroring `workitem_lane.task_statuses` exactly. */
const STATUS_TO_LANE: Record<TaskStatus, Lane> = {
  BACKLOG: "BACKLOG",
  TODO: "BACKLOG",
  IN_PROGRESS: "IN_PROGRESS",
  IN_REVIEW: "IN_REVIEW",
  BLOCKED: "IN_REVIEW",
  DONE: "DONE",
  CANCELLED: "CANCELLED",
};

export function laneOfTaskStatus(status: TaskStatus): Lane {
  return STATUS_TO_LANE[status];
}

/** Lane → the task statuses that live in it (the inverse of the table above). */
export const LANE_TASK_STATUSES: Record<Lane, TaskStatus[]> = {
  BACKLOG: ["BACKLOG", "TODO"],
  IN_PROGRESS: ["IN_PROGRESS"],
  IN_REVIEW: ["IN_REVIEW", "BLOCKED"],
  DONE: ["DONE"],
  CANCELLED: ["CANCELLED"],
};

/**
 * The status a card takes when it is dropped INTO a lane it does not already
 * belong to (`moveTask`). Every default is a member of its own lane — the test
 * asserts that, and it is what keeps a dropped card in the lane it was
 * dropped on.
 */
export const TASK_LANE_DEFAULT_STATUS: Record<Lane, TaskStatus> = {
  BACKLOG: "TODO",
  IN_PROGRESS: "IN_PROGRESS",
  IN_REVIEW: "IN_REVIEW",
  DONE: "DONE",
  CANCELLED: "CANCELLED",
};

/** Ticket.status → lane, mirroring `workitem_lane.ticket_statuses` exactly. */
const TICKET_STATUS_TO_LANE: Record<TicketStatus, Lane> = {
  OPEN: "BACKLOG",
  IN_PROGRESS: "IN_PROGRESS",
  RESOLVED: "DONE",
  CANCELLED: "CANCELLED",
};

export function laneOfTicketStatus(status: TicketStatus): Lane {
  return TICKET_STATUS_TO_LANE[status];
}

/** Lane → the ticket statuses that live in it. IN_REVIEW is empty — tickets
 *  have no review column (`workitem_lane` row `ARRAY[]::text[]`). */
export const LANE_TICKET_STATUSES: Record<Lane, TicketStatus[]> = {
  BACKLOG: ["OPEN"],
  IN_PROGRESS: ["IN_PROGRESS"],
  IN_REVIEW: [],
  DONE: ["RESOLVED"],
  CANCELLED: ["CANCELLED"],
};

/**
 * Lane → the ticket status a dropped ticket takes (`moveTicketToLane`).
 * IN_REVIEW is absent on purpose: the lane exists for tasks only, and the
 * mutation refuses a ticket drop onto it.
 */
export const TICKET_LANE_STATUS: Partial<Record<Lane, TicketStatus>> = {
  BACKLOG: "OPEN",
  IN_PROGRESS: "IN_PROGRESS",
  DONE: "RESOLVED",
  CANCELLED: "CANCELLED",
};

/** Statuses that count as settled for `isBlocked` — a blocker in either does
 *  not block. */
export const SETTLED_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "DONE",
  "CANCELLED",
]);
