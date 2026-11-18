import type { Express } from "express";
import { logger } from "~/lib/observability/logger.server";
import type { BootContext } from "~/server/boot";
import { dueEventSeries, extendEventSeries } from "./event-series.mutations.server";

export function register(_app: Express, ctx: BootContext) {
  let running = false;
  let stopped = false;
  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      const now = new Date();
      for (const { id } of await dueEventSeries(now)) {
        if (stopped) break;
        await extendEventSeries(id, now).catch((error: unknown) => {
          logger.error({ err: error, seriesId: id }, "Could not extend event series");
        });
      }
    } catch (error) {
      logger.error({ err: error }, "Could not find due event series");
    } finally {
      running = false;
    }
  }
  void tick();
  const timer = setInterval(
    () => {
      void tick();
    },
    60 * 60 * 1000,
  );
  timer.unref();
  ctx.onShutdown(() => {
    stopped = true;
    clearInterval(timer);
  });
}
