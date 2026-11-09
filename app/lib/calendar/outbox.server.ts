import { db } from "~/lib/db.server";
import type { CalendarPayload, CalendarPublisher } from "~/lib/calendar/publisher.server";

/**
 * Transactional-outbox drain. CalendarOutbox rows are produced in-tx by
 * the events domain (one row per (uid, iCal SEQUENCE)); this is the consumer side
 * that dispatches them to a CalendarPublisher. Pure + injectable: `drainOnce`
 * takes the publisher (real CalDav in prod, a fake in tests), so it needs no live
 * CalDAV server to test.
 *
 * Ordering guarantee (the reason calendars stay consistent): a lower sequence of a
 * uid is never sent after a higher one, or the calendar object would carry a
 * stale-but-higher SEQUENCE and never self-correct. Within a pass a uid's rows go
 * out in sequence order, and a failure blocks the rest of that uid for the pass.
 *
 * Every row carries the event's full state at its sequence, so a failed op is not
 * needed once a later one exists: at the start of each pass such a row is marked
 * SUPERSEDED and never sent, which lets the later op through instead of holding it
 * behind the failed one. A PUT that failed on the network may still be applied by
 * the server a moment later, so a failed row is superseded only once its backoff
 * (at least 30 s) has passed, and until then it holds back the later ops of its
 * uid, just as a retry of it would. A failed row with nothing after it is retried with
 * backoff until RETRY_WINDOW_MS after it was enqueued (and at least
 * MIN_ATTEMPTS_BEFORE_PARK times), then parked as FAILED
 * (where the event's next change still supersedes it). `calendarSyncHealth`
 * reports both cases on the admin status page.
 */

const BATCH_SIZE = 25;
export const DRAIN_LOCK_KEY = "jiangtang:calendar-outbox-drain";
/**
 * A pass starts no new push after PASS_BUDGET_MS, and each push is bounded by
 * CALDAV_REQUEST_TIMEOUT_MS, so a pass always ends well inside the lock's
 * transaction timeout and no push is still in flight once another instance can
 * take the lock.
 */
const PASS_BUDGET_MS = 5 * 60_000;
const DRAIN_LOCK_TIMEOUT_MS = 10 * 60_000;
const MAX_ERROR_LEN = 500;

// Exponential backoff after a failure: BASE * 2^(attempts-1), capped, measured
// from the failed attempt and stored as nextAttemptAt.
const BACKOFF_BASE_MS = 30_000; // 30s
const BACKOFF_CAP_MS = 60 * 60_000; // 1h

/** How long a failing push keeps being retried before it is parked as FAILED. */
export const RETRY_WINDOW_MS = 72 * 60 * 60_000;

/**
 * A row is never parked before this many attempts (about four hours of backoff),
 * so one that sat unsent past the window while the app or CalDAV was down still
 * gets a fair run of retries.
 */
const MIN_ATTEMPTS_BEFORE_PARK = 10;

/**
 * A row still failing after this many attempts (about eight minutes of backoff)
 * counts as stuck on the status page, long before the retry window parks it.
 */
const STUCK_AFTER_ATTEMPTS = 5;

export interface DrainResult {
  sent: number;
  failed: number;
  skipped: number;
  superseded: number;
}

export interface DrainOptions {
  /** Override batch size (tests). */
  batchSize?: number;
  /** Fixed "now" for deterministic backoff assertions (tests). */
  now?: Date;
  /**
   * Restrict the drain to rows whose eventUid starts with this prefix. Only used
   * by tests running against a shared database, to avoid touching other tests'
   * PENDING rows; production always drains every PENDING row.
   */
  eventUidPrefix?: string;
  /** Override the pass's time budget (tests). */
  passBudgetMs?: number;
}

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(attempts - 1, 20), BACKOFF_CAP_MS);
}

/**
 * Marks every failed op that a later op of the same uid has made obsolete. Only
 * rows that already failed at least once and whose backoff has passed are
 * touched: an untried lower row is simply sent first, in order.
 */
async function supersedeObsolete(now: Date, prefix: string | null): Promise<number> {
  return db.$executeRaw`
    UPDATE "CalendarOutbox" AS o
       SET status = 'SUPERSEDED', "processedAt" = ${now}, "nextAttemptAt" = NULL
     WHERE o.status IN ('PENDING', 'FAILED')
       AND o.attempts > 0
       AND (o."nextAttemptAt" IS NULL OR o."nextAttemptAt" <= ${now})
       AND (${prefix}::text IS NULL OR starts_with(o."eventUid", ${prefix}::text))
       AND EXISTS (
         SELECT 1 FROM "CalendarOutbox" AS h
          WHERE h."eventUid" = o."eventUid"
            AND h.sequence > o.sequence
            AND h.status IN ('PENDING', 'SENT')
       )`;
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
 * Drain up to `batchSize` due PENDING outbox rows through `publisher`.
 *
 * - Failed ops made obsolete by a later op of their uid are superseded first,
 *   once their backoff has passed; until then they hold back that later op.
 * - Only due rows are taken (never tried, or past nextAttemptAt), ordered by
 *   (eventUid asc, sequence asc), so rows waiting out a backoff never fill the
 *   batch and starve the rest.
 * - A failure blocks the uid's later sequences for the rest of the pass; the next
 *   pass supersedes the failed row if a later one exists.
 * - Success → SENT + processedAt. Failure → attempts+1, lastError, nextAttemptAt;
 *   once the row is older than RETRY_WINDOW_MS and has had MIN_ATTEMPTS_BEFORE_PARK
 *   tries it is parked as FAILED instead.
 */
export async function drainOnce(
  publisher: CalendarPublisher,
  opts?: DrainOptions,
): Promise<DrainResult> {
  // One pass at a time across every app instance: two drainers could otherwise
  // publish the same row twice, or supersede a row whose PUT another instance
  // still has in flight. The lock is transaction-scoped and non-blocking, so a
  // second instance skips its pass, and a crashed instance releases it with its
  // connection. The pass itself runs outside the transaction; holding it only
  // keeps the lock.
  return db.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${DRAIN_LOCK_KEY}, 0)) AS locked`;
      if (!row?.locked) return { sent: 0, failed: 0, skipped: 0, superseded: 0 };
      return drainPass(publisher, opts);
    },
    { maxWait: 10_000, timeout: DRAIN_LOCK_TIMEOUT_MS },
  );
}

async function drainPass(publisher: CalendarPublisher, opts?: DrainOptions): Promise<DrainResult> {
  const now = opts?.now ?? new Date();
  // Wall-clock, not `now`: tests move `now` freely, but the budget guards the lock.
  const startedAt = Date.now();
  const deadline = startedAt + (opts?.passBudgetMs ?? PASS_BUDGET_MS);
  // The instant a push failed, on `now`'s clock. A PUT can run up to its timeout
  // before it fails, and the server may still apply it a moment after that, so
  // the backoff that holds later ops back must start here, not at pass start.
  const failedAt = (): number => now.getTime() + (Date.now() - startedAt);
  const take = opts?.batchSize ?? BATCH_SIZE;
  const prefix = opts?.eventUidPrefix ?? null;

  const result: DrainResult = { sent: 0, failed: 0, skipped: 0, superseded: 0 };
  result.superseded = await supersedeObsolete(now, prefix);

  const pending = await db.calendarOutbox.findMany({
    where: {
      status: "PENDING",
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      ...(prefix ? { eventUid: { startsWith: prefix } } : {}),
    },
    orderBy: [{ eventUid: "asc" }, { sequence: "asc" }],
    take,
  });
  if (pending.length === 0) return result;

  // A lower sequence still waiting out its backoff is not in `pending`, but it
  // has not been superseded yet either, so later ops of its uid wait behind it.
  // A parked FAILED row in its backoff counts too: it is superseded, not retried,
  // once the backoff has passed.
  const waiting = await db.calendarOutbox.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      eventUid: { in: [...new Set(pending.map((r) => r.eventUid))] },
      nextAttemptAt: { gt: now },
    },
    select: { eventUid: true, sequence: true },
  });
  const lowestWaiting = new Map<string, number>();
  for (const w of waiting) {
    const cur = lowestWaiting.get(w.eventUid);
    if (cur === undefined || w.sequence < cur) lowestWaiting.set(w.eventUid, w.sequence);
  }

  // Per-uid "blocked from here on" flag, set once an earlier row fails this pass.
  const blocked = new Set<string>();

  for (const row of pending) {
    const waitingSeq = lowestWaiting.get(row.eventUid);
    if (
      Date.now() >= deadline ||
      blocked.has(row.eventUid) ||
      (waitingSeq !== undefined && waitingSeq < row.sequence)
    ) {
      result.skipped++;
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
        data: { status: "SENT", processedAt: now, lastError: null, nextAttemptAt: null },
      });
      result.sent++;
    } catch (e) {
      const attempts = row.attempts + 1;
      const parked =
        attempts >= MIN_ATTEMPTS_BEFORE_PARK &&
        now.getTime() - row.createdAt.getTime() >= RETRY_WINDOW_MS;
      const message = (e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_LEN);
      await db.calendarOutbox.update({
        where: { id: row.id },
        // A parked row keeps nextAttemptAt as the earliest instant a later op may
        // supersede it.
        data: {
          attempts,
          lastError: message,
          lastAttemptAt: new Date(failedAt()),
          nextAttemptAt: new Date(failedAt() + backoffMs(attempts)),
          ...(parked ? { status: "FAILED" as const } : {}),
        },
      });
      if (parked) {
        console.error(
          `[calendar] giving up on ${row.op} ${row.eventUid} seq ${row.sequence} after ${attempts} attempts: ${message}`,
        );
      }
      result.failed++;
      blocked.add(row.eventUid);
    }
  }

  return result;
}

export interface CalendarSyncStuckRow {
  eventUid: string;
  sequence: number;
  status: "PENDING" | "FAILED";
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  /** Null when the event has since been deleted. */
  event: { id: string; title: string } | null;
}

export interface CalendarSyncHealth {
  /** All PENDING rows, due or waiting out a backoff. */
  pending: number;
  /** PENDING rows that have failed at least STUCK_AFTER_ATTEMPTS times. */
  retrying: number;
  /** Rows parked after the retry window ran out. */
  failed: number;
  oldestStuckAt: Date | null;
  /** The oldest stuck rows (failed or retrying), oldest first. */
  stuck: CalendarSyncStuckRow[];
  /** When the most recent push reached the calendar. */
  lastSuccessAt: Date | null;
  /** The most recent failure of a push that has not gone through since. */
  lastError: { message: string; at: Date } | null;
}

/** Calendar push status for the admin page: what is waiting, retrying or parked. */
export async function calendarSyncHealth(opts?: {
  eventUidPrefix?: string;
  limit?: number;
}): Promise<CalendarSyncHealth> {
  const uid = opts?.eventUidPrefix ? { eventUid: { startsWith: opts.eventUidPrefix } } : {};
  const retryingWhere = {
    ...uid,
    status: "PENDING" as const,
    attempts: { gte: STUCK_AFTER_ATTEMPTS },
  };
  const [pending, retrying, failed, stuck, lastSent, lastFailed] = await Promise.all([
    db.calendarOutbox.count({ where: { ...uid, status: "PENDING" } }),
    db.calendarOutbox.count({ where: retryingWhere }),
    db.calendarOutbox.count({ where: { ...uid, status: "FAILED" } }),
    db.calendarOutbox.findMany({
      where: { OR: [{ ...uid, status: "FAILED" }, retryingWhere] },
      orderBy: { createdAt: "asc" },
      take: opts?.limit ?? 10,
      select: {
        eventUid: true,
        sequence: true,
        status: true,
        attempts: true,
        lastError: true,
        createdAt: true,
      },
    }),
    db.calendarOutbox.findFirst({
      where: { ...uid, status: "SENT" },
      orderBy: { processedAt: "desc" },
      select: { processedAt: true },
    }),
    db.calendarOutbox.findFirst({
      where: {
        ...uid,
        status: { in: ["PENDING", "FAILED"] },
        lastError: { not: null },
        lastAttemptAt: { not: null },
      },
      orderBy: { lastAttemptAt: "desc" },
      select: { lastError: true, lastAttemptAt: true },
    }),
  ]);
  const events = stuck.length
    ? await db.event.findMany({
        where: { uid: { in: [...new Set(stuck.map((r) => r.eventUid))] } },
        select: { id: true, uid: true, title: true },
      })
    : [];
  const eventByUid = new Map(events.map((e) => [e.uid, { id: e.id, title: e.title }]));
  return {
    pending,
    retrying,
    failed,
    oldestStuckAt: stuck[0]?.createdAt ?? null,
    stuck: stuck.map((r) => ({
      ...r,
      status: r.status === "FAILED" ? "FAILED" : "PENDING",
      event: eventByUid.get(r.eventUid) ?? null,
    })),
    lastSuccessAt: lastSent?.processedAt ?? null,
    lastError:
      lastFailed?.lastError && lastFailed.lastAttemptAt
        ? { message: lastFailed.lastError, at: lastFailed.lastAttemptAt }
        : null,
  };
}
