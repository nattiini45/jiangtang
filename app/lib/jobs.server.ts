import { fromPrisma, PgBoss } from "pg-boss";
import { readConfig } from "~/lib/config.server";
import type { Tx } from "~/lib/db.server";
import { logger } from "~/lib/observability/logger.server";

const globalForJobs = globalThis as typeof globalThis & { jiangtangJobQueue?: PgBoss };

export function getJobQueue() {
  return globalForJobs.jiangtangJobQueue;
}

export async function startJobQueue() {
  const connectionString = readConfig("DATABASE_URL");
  if (!connectionString) throw new Error("DATABASE_URL is required for background jobs.");
  const queue = new PgBoss({
    connectionString,
    schema: "pgboss",
    max: 4,
    options: "-c TimeZone=UTC",
  });
  queue.on("error", () => logger.error("[jobs] Queue operation failed"));
  try {
    await queue.start({ attempts: 3 });
  } catch (error) {
    await queue.stop({ graceful: false });
    throw error;
  }
  globalForJobs.jiangtangJobQueue = queue;
}

export async function stopJobQueue() {
  const queue = getJobQueue();
  delete globalForJobs.jiangtangJobQueue;
  await queue?.stop({ timeout: 5_000 });
}

export async function enqueueJob(tx: Tx, name: string, data: object, startAfter?: Date) {
  const queue = getJobQueue();
  if (!queue) throw new Error("Background job queue is unavailable.");
  return queue.send(name, data, { db: fromPrisma(tx), startAfter });
}
