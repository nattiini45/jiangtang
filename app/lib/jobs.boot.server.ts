import type { Express } from "express";
import { startJobQueue, stopJobQueue } from "~/lib/jobs.server";
import { logger } from "~/lib/observability/logger.server";
import type { BootContext } from "~/server/boot";

export const order = -1;

export async function register(_app: Express, ctx: BootContext) {
  try {
    await startJobQueue();
    ctx.onShutdown(stopJobQueue);
  } catch {
    logger.error("[jobs] Queue unavailable; check the database connection and pgboss permissions");
  }
}
