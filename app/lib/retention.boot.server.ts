import { readConfig } from "~/lib/config.server";
import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import { pruneActivityLog } from "~/domains/auth/gdpr.server";

/**
 * Retention boot job. Once a day, prunes ActivityLog rows older than
 * the configured retention window (default 7 years, overridable via
 * ACTIVITY_RETENTION_DAYS). Uses the sanctioned `prune_activity_log` SECURITY
 * DEFINER function — the only path that can DELETE audit rows past the
 * immutability trigger.
 *
 * Runs an immediate tick on boot (so a freshly-restarted server catches up),
 * then a daily interval. The window is generous by default: the audit log is
 * operational history, not just a compliance artifact.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention window in days, from `ACTIVITY_RETENTION_DAYS` (default ~7 years). */
export function getRetentionDays(): number {
  // Guard against a malformed value (e.g. "thirty" → NaN, or a non-positive
  // number): an Invalid Date cutoff would make prune_activity_log throw on every
  // tick (caught + logged), silently disabling retention. Fall back to the
  // default rather than fail silently.
  return readConfig("ACTIVITY_RETENTION_DAYS");
}

/**
 * The cutoff instant for "older than the retention window", computed fresh from
 * `Date.now()` each call. It must NOT be memoized across ticks — a boot-time
 * snapshot would freeze the cutoff forever and the window would stop advancing, so
 * every `tick()` (and every test) recomputes it.
 */
export function retentionCutoff(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * DAY_MS);
}

export async function register(_app: Express, ctx: BootContext): Promise<void> {
  const retentionDays = getRetentionDays();

  async function tick(): Promise<void> {
    try {
      const deleted = await pruneActivityLog(retentionCutoff(retentionDays));
      if (deleted > 0) {
        console.log(`[retention] pruned ${deleted} activity rows older than ${retentionDays}d`);
      }
    } catch (e) {
      console.error("[retention] prune failed:", (e as Error).message);
    }
  }

  // Catch-up on boot, then daily. Unref'd so the interval never keeps the process alive.
  void tick();
  const handle = setInterval(tick, DAY_MS);
  handle.unref?.();
  ctx.onShutdown(() => clearInterval(handle));
}
