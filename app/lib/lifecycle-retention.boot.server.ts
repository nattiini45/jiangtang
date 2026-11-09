import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import {
  pruneExpiredSessions,
  pruneExpiredVerifications,
} from "~/domains/auth/auth.retention.server";
import { pruneReadNotifications } from "~/domains/notifications/notifications.mutations.server";
import { pruneCompletedCalendarOutbox } from "~/lib/calendar/retention.server";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function pruneLifecycleData(now = new Date()): Promise<void> {
  const outboxCutoff = new Date(now.getTime() - 30 * DAY_MS);
  const notificationCutoff = new Date(now.getTime() - 90 * DAY_MS);
  const categories = [
    ["sessions", () => pruneExpiredSessions(now)],
    ["verifications", () => pruneExpiredVerifications(now)],
    ["outbox", () => pruneCompletedCalendarOutbox(outboxCutoff)],
    ["notifications", () => pruneReadNotifications(notificationCutoff)],
  ] as const;

  for (const [category, prune] of categories) {
    try {
      const deleted = await prune();
      if (deleted > 0) console.log(`[lifecycle-retention] pruned ${deleted} ${category}`);
    } catch {
      console.error(`[lifecycle-retention] ${category} cleanup failed`);
    }
  }
}

export async function register(_app: Express, ctx: BootContext): Promise<void> {
  let running = false;
  let stopped = false;
  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      await pruneLifecycleData();
    } finally {
      running = false;
    }
  }

  void tick();
  const handle = setInterval(tick, DAY_MS);
  handle.unref?.();
  ctx.onShutdown(() => {
    stopped = true;
    clearInterval(handle);
  });
}
