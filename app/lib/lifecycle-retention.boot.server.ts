import type { Express } from "express";
import {
  pruneExpiredSessions,
  pruneExpiredVerifications,
} from "~/domains/auth/auth.retention.server";
import { pruneReadNotifications } from "~/domains/notifications/notifications.mutations.server";
import { pruneCompletedCalendarOutbox } from "~/lib/calendar/retention.server";
import { getJobQueue } from "~/lib/jobs.server";
import { logger } from "~/lib/observability/logger.server";
import type { BootContext } from "~/server/boot";

const DAY_MS = 24 * 60 * 60 * 1000;
const QUEUE = "lifecycle-retention";

export async function pruneLifecycleData(now = new Date()) {
  const outboxCutoff = new Date(now.getTime() - 30 * DAY_MS);
  const notificationCutoff = new Date(now.getTime() - 90 * DAY_MS);
  const categories = [
    ["sessions", () => pruneExpiredSessions(now)],
    ["verifications", () => pruneExpiredVerifications(now)],
    ["outbox", () => pruneCompletedCalendarOutbox(outboxCutoff)],
    ["notifications", () => pruneReadNotifications(notificationCutoff)],
  ] as const;

  const deleted: Record<string, number> = {};
  const failed: string[] = [];
  for (const [category, prune] of categories) {
    try {
      const count = await prune();
      deleted[category] = count;
      if (count > 0) console.log(`[lifecycle-retention] pruned ${count} ${category}`);
    } catch {
      failed.push(category);
      console.error(`[lifecycle-retention] ${category} cleanup failed`);
    }
  }
  if (failed.length) throw new Error(`Lifecycle cleanup failed: ${failed.join(", ")}`);
  return deleted;
}

export async function register(_app: Express, ctx: BootContext): Promise<void> {
  const queue = getJobQueue();
  if (queue) {
    try {
      await queue.createQueue(QUEUE, {
        policy: "singleton",
        retryLimit: 4,
        retryDelay: 30,
        retryBackoff: true,
        deleteAfterSeconds: 30 * 86_400,
      });
      await queue.schedule(QUEUE, "0 3 * * *");
      await queue.send(QUEUE, null, { singletonSeconds: 60 });
      await queue.work(QUEUE, { pollingIntervalSeconds: 10 }, () => pruneLifecycleData());
      return;
    } catch {
      logger.error("[lifecycle-retention] Could not register the cleanup queue");
    }
  }

  logger.warn("[lifecycle-retention] Running cleanup on the local timer");
  let stopped = false;
  let running = false;
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      await pruneLifecycleData();
    } catch {
      return;
    } finally {
      running = false;
    }
  }
  void tick();
  const handle = setInterval(tick, DAY_MS);
  handle.unref();
  ctx.onShutdown(() => {
    stopped = true;
    clearInterval(handle);
  });
}
