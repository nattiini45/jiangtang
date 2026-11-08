import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import { sweepDueSoon } from "~/domains/notifications/notifications.mutations.server";

/**
 * Due-soon sweep boot job. Hourly: one TASK_DUE_SOON notification per assignee
 * of every open task due within the horizon, deduplicated by (user, type,
 * entity) so repeats never spam. Immediate tick on boot, then hourly; the
 * timer is unref'd and cleared on shutdown.
 */
const HOUR_MS = 60 * 60 * 1000;

export async function runDueSoonSweep(): Promise<number> {
  return sweepDueSoon();
}

export async function register(_app: Express, ctx: BootContext): Promise<void> {
  async function tick(): Promise<void> {
    try {
      const n = await runDueSoonSweep();
      if (n > 0) console.log(`[notifications] ${n} due-soon notification(s) created`);
    } catch (e) {
      console.error("[notifications] due-soon sweep failed:", (e as Error).message);
    }
  }
  void tick();
  const handle = setInterval(() => void tick(), HOUR_MS);
  handle.unref?.();
  ctx.onShutdown(() => clearInterval(handle));
}
