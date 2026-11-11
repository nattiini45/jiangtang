import { readConfig } from "~/lib/config.server";
/**
 * Search index worker. Auto-loaded boot module —
 * never throws, never blocks startup, and stays out of tests entirely.
 *
 * Disabled when `NODE_ENV === "test"` or `SEARCH_INDEXER=off`. Otherwise:
 *  - boot: `reconcileAll()` then `embedPending` until drained;
 *  - steady state: a 60 s reconcile sweep (the safety net — a missed NOTIFY
 *    self-heals within a minute);
 *  - fast path: the shared LISTEN broker (`jiangtang_changes`) maps entity types
 *    to source types and debounces 500 ms per source before
 *    `reindexSource` → `embedPending`.
 */
import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import { logger } from "~/lib/observability/logger.server";
import { broker } from "~/lib/realtime/listener.server";
import type { RealtimeEvent } from "~/lib/realtime/events";
import { ENTITY_TO_SOURCE, type SourceType } from "./sources.server";
import { embedPending, reconcileAll, reindexSource } from "./indexer.server";

const RECONCILE_INTERVAL_MS = 60_000;
const DEBOUNCE_MS = 500;
const SUBSCRIBER_ID = "search-indexer";
const MAX_DRAIN_ROUNDS = 20;

async function drainEmbeds(): Promise<void> {
  for (let i = 0; i < MAX_DRAIN_ROUNDS; i++) {
    const { embedded } = await embedPending({ limit: 256 });
    if (embedded === 0) return;
  }
}

export function register(_app: Express, ctx: BootContext): void {
  if (readConfig("NODE_ENV") === "test" || readConfig("SEARCH_INDEXER") === "off") return;

  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const kick = (type: SourceType, id: string) => {
    const key = `${type}:${id}`;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void reindexSource(type, id)
          .then(() => embedPending({ limit: 256 }))
          .catch((e) =>
            logger.warn(
              { err: (e as Error).message, sourceType: type, sourceId: id },
              "[search] reindex failed",
            ),
          );
      }, DEBOUNCE_MS),
    );
    timers.get(key)?.unref?.();
  };

  const onEvent = (ev: RealtimeEvent) => {
    const type = ENTITY_TO_SOURCE[ev.entityType];
    if (type) kick(type, ev.id);
  };

  // Boot catch-up, fire-and-forget: a slow first sweep must not delay startup.
  void (async () => {
    try {
      await broker.ensureStarted();
      broker.subscribe(SUBSCRIBER_ID, onEvent);
      const report = await reconcileAll();
      if (report.reindexed || report.deletedOrphans) {
        logger.info(report, "[search] reconcile on boot");
      }
      await drainEmbeds();
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "[search] boot sweep failed");
    }
  })();

  const interval = setInterval(() => {
    void reconcileAll()
      .then(() => drainEmbeds())
      .catch((e) => logger.warn({ err: (e as Error).message }, "[search] reconcile failed"));
  }, RECONCILE_INTERVAL_MS);
  interval.unref?.();

  ctx.onShutdown(() => {
    clearInterval(interval);
    for (const t of timers.values()) clearTimeout(t);
    broker.unsubscribe(SUBSCRIBER_ID);
  });
}
