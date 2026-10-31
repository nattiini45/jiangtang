import { db } from "~/lib/db.server";
import type { CalendarPayload, CalendarPublisher } from "~/lib/calendar/publisher.server";

/**
 * Transactional-outbox drain. CalendarOutbox rows are produced in-tx by
 * the events domain (one row per (uid, iCal SEQUENCE)); this is the consumer side
 * that dispatches them to a CalendarPublisher. Pure + injectable: `drainOnce`
 * takes the publisher (real CalDav in prod, a fake in tests), so it needs no live
 * CalDAV server to test.
 *
 * Ordering guarantee (the reason calendars stay consistent): a uid's sequences are
 * dispatched strictly in order. We NEVER send sequence N+1 for a uid while a lower
 * sequence of that uid is still PENDING or already FAILED — a lower op that hasn't
 * landed (or is poison-parked) must not be overtaken by a later state, or the
 * calendar object would carry a stale-but-higher SEQUENCE and never self-correct.
 */

const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;
const MAX_ERROR_LEN = 500;

// Exponential backoff: BASE * 2^(attempts-1), capped. A freshly-enqueued row
// (attempts === 0) is always eligible; a retried row waits progressively longer.
const BACKOFF_BASE_MS = 30_000; // 30s
const BACKOFF_CAP_MS = 60 * 60_000; // ~1h

export interface DrainResult {
  sent: number;
  failed: number;
  skipped: number;
}

export interface DrainOptions {
  /** Override batch size (tests). */
  batchSize?: number;
  /** Fixed "now" for deterministic backoff assertions (tests). */
  now?: Date;
  /**
   * Restrict the drain to rows whose eventUid starts with this prefix. Only used
   * by tests running against the SHARED dev DB, to avoid touching other tracks'
   * PENDING rows; production always drains every PENDING row.
   */
  eventUidPrefix?: string;
}

/** Backoff gate: is a PENDING row with prior attempts due for another try? */
function isBackoffDue(attempts: number, lastAttemptAt: Date, now: Date): boolean {
  if (attempts <= 0) return true;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
  return now.getTime() >= lastAttemptAt.getTime() + delay;
}

/** Reconstruct the typed payload (ISO strings → Date) from the stored JSON. */
function payloadFromJson(raw: unknown): CalendarPayload {
  const p = raw as {
    uid: string;
    title: string;
    description?: string;
    startsAt: string;
    endsAt: string;
    location?: string;
    sequence: number;
  };
  return {
    uid: p.uid,
    title: p.title,
    description: p.description,
    startsAt: new Date(p.startsAt),
    endsAt: new Date(p.endsAt),
    location: p.location,
    timezone: "Europe/Berlin",
    sequence: p.sequence,
  };
}

/**
 * Drain up to `batchSize` PENDING outbox rows through `publisher`.
 *
 * - Rows are taken ordered by (eventUid asc, sequence asc) so a uid's ops are seen
 *   in sequence order.
 * - A uid is BLOCKED for the rest of this pass once one of its rows is skipped
 *   (backoff not due) or fails — later sequences of that uid are then skipped, so
 *   an earlier op is never overtaken.
 * - A pre-existing FAILED (poison) row also blocks all higher sequences of its uid.
 * - Success → SENT + processedAt. Failure → attempts+1, lastError; at
 *   attempts >= MAX_ATTEMPTS the row is parked as FAILED (stays skipped, keeps
 *   blocking later sequences of its uid).
 */
export async function drainOnce(
  publisher: CalendarPublisher,
  opts?: DrainOptions,
): Promise<DrainResult> {
  const now = opts?.now ?? new Date();
  const take = opts?.batchSize ?? BATCH_SIZE;
  const uidFilter = opts?.eventUidPrefix ? { startsWith: opts.eventUidPrefix } : undefined;

  const pending = await db.calendarOutbox.findMany({
    where: { status: "PENDING", ...(uidFilter ? { eventUid: uidFilter } : {}) },
    orderBy: [{ eventUid: "asc" }, { sequence: "asc" }],
    take,
  });

  const result: DrainResult = { sent: 0, failed: 0, skipped: 0 };
  if (pending.length === 0) return result;

  // A uid whose lowest FAILED sequence is <= a candidate's sequence blocks it —
  // the poison row must land (or be cleared) before later ops are allowed through.
  const uids = [...new Set(pending.map((r) => r.eventUid))];
  const failedRows = uids.length
    ? await db.calendarOutbox.findMany({
        where: { status: "FAILED", eventUid: { in: uids } },
        select: { eventUid: true, sequence: true },
      })
    : [];
  const minFailedSeq = new Map<string, number>();
  for (const f of failedRows) {
    const cur = minFailedSeq.get(f.eventUid);
    if (cur === undefined || f.sequence < cur) minFailedSeq.set(f.eventUid, f.sequence);
  }

  // Per-uid "blocked from here on" flag, set once an earlier row is skipped/failed.
  const blocked = new Set<string>();

  for (const row of pending) {
    // A poison row at or below this sequence blocks the uid (and everything after).
    const failedSeq = minFailedSeq.get(row.eventUid);
    if (failedSeq !== undefined && failedSeq <= row.sequence) {
      result.skipped++;
      blocked.add(row.eventUid);
      continue;
    }
    if (blocked.has(row.eventUid)) {
      result.skipped++;
      continue;
    }
    // Backoff: a retried row not yet due is skipped AND blocks later sequences of
    // its uid this pass (it's an earlier op that hasn't landed). The model has no
    // updatedAt, so createdAt approximates the last-attempt instant — good enough
    // for backoff spacing (a row's createdAt is fixed but attempts grow the delay).
    if (!isBackoffDue(row.attempts, row.createdAt, now)) {
      result.skipped++;
      blocked.add(row.eventUid);
      continue;
    }

    try {
      const payload = payloadFromJson(row.payload);
      if (row.op === "UPSERT") {
        await publisher.upsert(payload);
      } else {
        await publisher.remove(row.eventUid, row.sequence);
      }
      await db.calendarOutbox.update({
        where: { id: row.id },
        data: { status: "SENT", processedAt: now, lastError: null },
      });
      result.sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const parked = attempts >= MAX_ATTEMPTS;
      const message = (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_LEN);
      await db.calendarOutbox.update({
        where: { id: row.id },
        data: {
          attempts,
          lastError: message,
          ...(parked ? { status: "FAILED" as const } : {}),
        },
      });
      result.failed++;
      // This op didn't land → block later sequences of the same uid this pass.
      blocked.add(row.eventUid);
    }
  }

  return result;
}
