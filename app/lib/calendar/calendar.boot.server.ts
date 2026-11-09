import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import { NoopPublisher } from "~/lib/calendar/publisher.server";
import { getPublisher } from "~/lib/calendar/publisher-factory.server";
import { drainOnce } from "~/lib/calendar/outbox.server";
import { initializeCalendarPublication } from "~/lib/calendar/initial-publication.server";

/**
 * Calendar-outbox drain worker. Periodically dispatches PENDING
 * CalendarOutbox rows to the configured CalendarPublisher (CalDAV), so calendar
 * ops enqueued in-tx by event mutations actually reach the shared calendar.
 *
 * Config-gated: when CALDAV_* is unset getPublisher() returns a NoopPublisher —
 * we then log once and DO NOT start an interval, so an unconfigured install has
 * byte-identical behavior to before this worker existed (no idle timer, no work).
 *
 * When configured: an immediate catch-up tick on boot, then a short interval.
 * Unref'd so the timer never keeps the process alive; cleared on shutdown.
 */

const INTERVAL_MS = 15_000;

export async function register(_app: Express, ctx: BootContext): Promise<void> {
  const publisher = getPublisher();

  // No CALDAV_* → stay completely idle (no interval), matching pre-worker behavior.
  if (publisher instanceof NoopPublisher) {
    console.log("[calendar] CALDAV_* not set — outbox drain idle");
    return;
  }

  // Re-entrancy guard: a slow CalDAV target (per-PUT latency > INTERVAL_MS) must
  // not let a second drain start while one is in flight — two concurrent drains
  // would both see a not-yet-flipped PENDING seq N and could land N after N+1 on
  // the server (unconditional PUTs), breaking the per-uid ordering guarantee.
  let running = false;
  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      if (!(await initializeCalendarPublication())) return;
      const { sent, failed, skipped, superseded } = await drainOnce(publisher);
      if (sent || failed || skipped || superseded) {
        console.log(
          `[calendar] outbox drained: sent=${sent} failed=${failed} skipped=${skipped} superseded=${superseded}`,
        );
      }
    } catch (e) {
      console.error("[calendar] outbox drain failed:", (e as Error).message);
    } finally {
      running = false;
    }
  }

  // Catch-up on boot, then a short interval. Unref'd so it never blocks exit.
  void tick();
  const handle = setInterval(tick, INTERVAL_MS);
  handle.unref?.();
  ctx.onShutdown(() => clearInterval(handle));
}
