import { db } from "~/lib/db.server";
import { ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { STOCK_INCLUDE } from "./inventory.stock.queries.server";

/**
 * Warranty expiry sweep — the query (`InventoryItem.warrantyExpiresAt`).
 *
 * 🔴 **This module WRITES NOTHING, and that is the invariant, not an omission.**
 * The obvious implementation of a "warranty sweep" is
 * to *flag* expiring items — and the only field for a flag is
 * `InventoryItem.status`. Typing that field (shipped) did not make warranty
 * expiry a **custody** transition, and a sweep that writes a status is the schema
 * answering a product question no document asks. So the sweep is a **query plus a
 * boot-time count**: it returns what is expiring, logs how much, and writes no
 * `status` and no `ActivityLog` row. When the presentation is built, this query is
 * reusable unchanged.
 *
 * `status` is typed as `StockStatus` with `AVAILABLE` as its resting value.
 * **Typing it does not license this module to set a status.**
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The default look-ahead. */
export const DEFAULT_WARRANTY_WINDOW_DAYS = 30;

/**
 * The look-ahead window in days, from `WARRANTY_WINDOW_DAYS` (default 30).
 *
 * The malformed-value guard is `retention.boot.server.ts`'s, for its reason: a
 * non-numeric or non-positive env value would produce an `Invalid Date` bound, and
 * the sweep would then throw on **every** tick — caught and logged — which is
 * retention silently switched off while the logs look healthy. Fall back to the
 * default instead. (`Number("")` is `0`, so an empty variable also lands here.)
 */
export function getWarrantyWindowDays(): number {
  const raw = Number(process.env.WARRANTY_WINDOW_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WARRANTY_WINDOW_DAYS;
}

/** The two ends of the window, recomputed on every call. */
export interface WarrantyWindow {
  /** Inclusive: an item expiring exactly now is expiring. */
  from: Date;
  /** Inclusive: an item expiring in exactly `withinDays` days is inside a "30 day" window. */
  to: Date;
}

/**
 * The window `[now, now + withinDays]`, computed fresh from `now` on each call.
 *
 * ⚠️ **Never memoize this** (`retentionCutoff` lives under the same constraint):
 * a boot-time snapshot would
 * freeze the window at the instant the process started, so a server left running
 * for a week would keep asking about the week it booted in. The `now` parameter
 * exists so a test can pin the instant — the production callers all omit it.
 */
export function warrantyWindow(withinDays: number, now: Date = new Date()): WarrantyWindow {
  return { from: now, to: new Date(now.getTime() + withinDays * DAY_MS) };
}

export interface ExpiringWarrantiesOptions {
  /**
   * Look-ahead in days. Omit to use `WARRANTY_WINDOW_DAYS` (default 30).
   *
   * ⚠️ **An explicit value is validated rather than silently corrected, and that
   * asymmetry is deliberate.** The env path falls back to the default because a
   * malformed env var would otherwise disable the job. An explicit argument is a
   * caller bug, and quietly widening the window would hand back rows the caller
   * did not ask for — a wrong answer instead of a visible failure.
   */
  withinDays?: number;
  /** Test seam: pin "now" so the window's bounds are assertable. */
  now?: Date;
}

/**
 * Stock items whose warranty expires inside the window, **soonest first**.
 *
 * **The lower bound is what makes this a sweep and not a report.** The window is
 * `[now, now + withinDays]`, so a warranty that expired *yesterday* is **not**
 * returned: it is not expiring, it expired. The sweep asks for "what is
 * expiring", so expiring warranties *surface* — an item that
 * expired last quarter is a procurement fact, not a sweep finding, and folding it
 * in would make the count grow without bound and mean something different every
 * day. The alternative reading (everything at or before the cut-off) was
 * considered; it is a query change, not a schema one, and reverts in one line.
 *
 * `warrantyExpiresAt: null` is excluded by the `gte`/`lte` bounds themselves —
 * NULL compares false against both — and by the explicit `not: null`, so the
 * exclusion is stated rather than inferred from comparison semantics.
 *
 * Ordering is `warrantyExpiresAt` then `id`: the date is not unique, so ordering
 * by it alone leaves ties to the planner and two identical queries can return the
 * same rows in different orders. That is the same tiebreak `listStock` uses.
 */
export async function listExpiringWarranties(options: ExpiringWarrantiesOptions = {}) {
  const withinDays = options.withinDays ?? getWarrantyWindowDays();
  if (!Number.isFinite(withinDays) || withinDays <= 0) {
    throw new ValidationError({ withinDays: [tr("places.err.warranty.windowPositive")] });
  }
  const { from, to } = warrantyWindow(withinDays, options.now);
  return db.inventoryItem.findMany({
    where: {
      warrantyExpiresAt: { not: null, gte: from, lte: to },
    },
    include: STOCK_INCLUDE,
    orderBy: [{ warrantyExpiresAt: "asc" }, { id: "asc" }],
  });
}
