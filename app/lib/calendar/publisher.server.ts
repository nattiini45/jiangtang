import type { Tx } from "~/lib/db.server";
import type { Prisma } from "~/generated/prisma/client";

/**
 * Calendar publishing seam (FROZEN interface + transactional-outbox enqueue).
 * Output-only push of AV events to a shared CalDAV calendar + an iCal feed
 *. CalDAV downtime must never block app writes — so mutations
 * ENQUEUE an outbox row in the same transaction; the drain worker publishes
 * it out-of-band via a CalendarPublisher (CalDavPublisher in prod, Noop when
 * unconfigured). There is no Exchange/Graph path.
 */

export interface CalendarPayload {
  uid: string;
  title: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  location?: string;
  /** Always Europe/Berlin — embed VTIMEZONE in the published .ics. */
  timezone: "Europe/Berlin";
  /** iCal SEQUENCE for update/cancel ordering. */
  sequence: number;
}

export interface CalendarPublisher {
  upsert(payload: CalendarPayload): Promise<void>;
  remove(uid: string, sequence: number): Promise<void>;
}

/** A no-op publisher (the fallback when CALDAV_* is unconfigured). */
export class NoopPublisher implements CalendarPublisher {
  async upsert(): Promise<void> {}
  async remove(): Promise<void> {}
}

export type CalendarOp = "UPSERT" | "REMOVE";

export interface CalendarOutboxRow {
  op: CalendarOp;
  eventUid: string;
  sequence: number;
  payload: CalendarPayload;
}

/** JSON-safe serialization of a payload (Dates → ISO strings). */
function serializePayload(payload: CalendarPayload): Prisma.InputJsonValue {
  return {
    ...payload,
    startsAt: payload.startsAt.toISOString(),
    endsAt: payload.endsAt.toISOString(),
  };
}

/**
 * Enqueue a calendar operation in the SAME transaction as the event mutation
 * (so it commits/rolls back atomically with the change). The drain worker
 * reads PENDING rows and publishes them idempotently by (eventUid, sequence).
 */
export async function enqueueCalendarOp(tx: Tx, row: CalendarOutboxRow): Promise<void> {
  await tx.calendarOutbox.create({
    data: {
      op: row.op,
      eventUid: row.eventUid,
      sequence: row.sequence,
      payload: serializePayload(row.payload),
    },
  });
}
