/**
 * Realtime event contract (FROZEN: channel name + JSON codec). Producer is
 * `emitChange` (emit.server.ts); the consumer (shared LISTEN + per-session SSE
 * fan-out) lives in `listener.server.ts`. Clients treat events as a refetch trigger, not truth.
 *
 * The freeze covers the CHANNEL NAME and the JSON CODEC. It does not cover the
 * member list below — adding a member changes neither, and the payload stays
 * `{ entityType, id, op, ts }`.
 */

export const REALTIME_CHANNEL = "jiangtang_changes";

/**
 * THE one entity-type vocabulary.
 *
 * It is a runtime array rather than a bare `type` union so that three things
 * become possible:
 *
 *  1. `audit()` can be typed by it, so a wrong spelling is a COMPILE error
 *     rather than a row no reader can find.
 *  2. A test can enumerate it without parsing TypeScript source.
 *  3. `ENTITY_TYPE` in `app/domains/tickets/tickets.history.server.ts` can be
 *     checked for completeness against it, so the map cannot fall behind the
 *     vocabulary the writers use.
 *
 * ⚠️ **This is a permission list, not a mirror of the schema**. It is
 * "the things a client may need to refetch after they change", which is
 * deliberately a subset — `Session`, `Account`, `Verification` and
 * `CalendarOutbox` are models with no business on an SSE wire, and
 * deriving it from `ModelName` would rename 5 live members and admit 12 more.
 *
 * Every member is also an `ActivityLog.entityType`: the audit column and this
 * wire are ONE vocabulary, and unifying them is what ends the split.
 * That is why `project`/`task`/`note`/`vendor` are here — `prisma/seed.ts`
 * audits all eight of its demo families through `txWithAudit`, so a union that
 * omitted them could not type the tree.
 */
export const ENTITY_TYPES = [
  "campus",
  "building",
  "room",
  "equipmentModel",
  "equipment",
  "ticket",
  "event",
  "eventRoomBooking",
  "equipmentAllocation",
  "serviceWindow",
  "attachment",
  "user",
  "activityLog",
  "location",
  "inventory-item",
  "project",
  "task",
  "note",
  "vendor",
  "timeEntry",
  "notification",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export type ChangeOp = "created" | "updated" | "deleted";

export interface RealtimeEvent {
  entityType: EntityType;
  id: string;
  op: ChangeOp;
  /** Epoch milliseconds at emit time (also serves as SSE lastEventId basis). */
  ts: number;
}

export function encodeRealtimeEvent(ev: RealtimeEvent): string {
  return JSON.stringify(ev);
}

export function decodeRealtimeEvent(payload: string): RealtimeEvent {
  const parsed = JSON.parse(payload) as Partial<RealtimeEvent>;
  if (!parsed.entityType || !parsed.id || !parsed.op || typeof parsed.ts !== "number") {
    throw new Error(`Malformed RealtimeEvent payload: ${payload}`);
  }
  return parsed as RealtimeEvent;
}
