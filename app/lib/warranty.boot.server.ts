import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import {
  getWarrantyWindowDays,
  listExpiringWarranties,
} from "~/domains/inventory/inventory.stock.warranty.server";

/**
 * Warranty sweep boot job (`InventoryItem.warrantyExpiresAt`,
 * "warranty expiry sweep"). Once a day, counts the stock whose warranty expires
 * inside the look-ahead window and logs the count. Shape follows
 * `retention.boot.server.ts`.
 *
 * 🔴 **It writes nothing** — no `status`, no `ActivityLog` row, and no write of
 * any kind. The only database call here is the read
 * behind `listExpiringWarranties`. The count is a log line because a service desk
 * needs to know the number without anyone having to build a screen for it first,
 * and the query is the reusable half; the writing half is deliberately absent until
 * a document asks for it.
 *
 * Immediate tick on boot (a freshly-restarted server catches up), then daily.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One sweep: reads, logs, returns how many items are expiring. Exported so a test
 * can drive a tick directly and assert the *absence* of writes — the property the
 * row exists to protect is only observable by running the tick.
 */
export async function runWarrantySweep(): Promise<number> {
  const withinDays = getWarrantyWindowDays();
  const expiring = await listExpiringWarranties({ withinDays });
  if (expiring.length > 0) {
    console.log(`[warranty] ${expiring.length} item(s) expire within ${withinDays}d`);
  }
  return expiring.length;
}

export async function register(_app: Express, _ctx: BootContext): Promise<void> {
  async function tick(): Promise<void> {
    try {
      await runWarrantySweep();
    } catch (e) {
      // A failed sweep must not take the process down, and must be visible: a
      // silently-dead sweep is indistinguishable from one that found nothing.
      console.error("[warranty] sweep failed:", (e as Error).message);
    }
  }

  // Catch-up on boot, then daily. Unref'd so the interval never keeps the process alive.
  void tick();
  const handle = setInterval(tick, DAY_MS);
  handle.unref?.();
}
