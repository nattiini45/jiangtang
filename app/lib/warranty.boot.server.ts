import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import {
  getWarrantyWindowDays,
  listExpiringWarranties,
} from "~/domains/inventory/inventory.stock.warranty.server";
import { notifyWarrantyExpiring } from "~/domains/notifications/notifications.mutations.server";

/**
 * Warranty sweep boot job (`InventoryItem.warrantyExpiresAt`,
 * "warranty expiry sweep"). Once a day, reads the stock whose warranty expires
 * inside the look-ahead window and writes one WARRANTY_EXPIRING inbox
 * notification per item per active admin (deduplicated by item, so repeat
 * ticks never spam). The count is still logged for the service desk.
 * No `ActivityLog` rows: notifications are system-generated side effects, not
 * user mutations. Shape follows `retention.boot.server.ts`.
 *
 * Immediate tick on boot (a freshly-restarted server catches up), then daily.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One sweep: reads, notifies, logs, returns how many items are expiring.
 * Exported so a test can drive a tick directly.
 */
export async function runWarrantySweep(): Promise<number> {
  const withinDays = getWarrantyWindowDays();
  const expiring = await listExpiringWarranties({ withinDays });
  if (expiring.length > 0) {
    console.log(`[warranty] ${expiring.length} item(s) expire within ${withinDays}d`);
    await notifyWarrantyExpiring(
      expiring.map((i) => ({
        id: i.id,
        name: i.name,
        warrantyExpiresAt: i.warrantyExpiresAt!,
      })),
    );
  }
  return expiring.length;
}

export async function register(_app: Express, ctx: BootContext): Promise<void> {
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
  ctx.onShutdown(() => clearInterval(handle));
}
