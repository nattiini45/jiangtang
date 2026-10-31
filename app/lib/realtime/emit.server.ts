import { db } from "~/lib/db.server";
import {
  REALTIME_CHANNEL,
  encodeRealtimeEvent,
  type ChangeOp,
  type EntityType,
  type RealtimeEvent,
} from "~/lib/realtime/events";

/**
 * Post-commit realtime producer. Call AFTER `txWithAudit(...)` resolves:
 *
 *   await txWithAudit(actor, (tx) => …);
 *   await emitChange({ entityType: "ticket", id, op: "updated" });
 *
 * Issues a Postgres NOTIFY via parameterized `pg_notify` (no identifier-quoting
 * pitfalls, payload-length safe). The shared LISTEN consumer fans it out to
 * SSE subscribers, which then refetch.
 */
export async function emitChange(input: {
  entityType: EntityType;
  id: string;
  op: ChangeOp;
  ts?: number;
}): Promise<void> {
  const ev: RealtimeEvent = {
    entityType: input.entityType,
    id: input.id,
    op: input.op,
    ts: input.ts ?? Date.now(),
  };
  const payload = encodeRealtimeEvent(ev);
  await db.$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${payload})`;
}
