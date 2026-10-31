/**
 * AI capability status at boot: "a degraded brain is visible in
 * logs rather than discovered by a user". Logs each capability's resolution —
 * state, model, endpoint host (never keys or credential-bearing URLs) — and,
 * when embedding resolves to `api`, fires a non-blocking `ping` probe so a
 * dead endpoint surfaces at startup instead of first search. Never throws,
 * never blocks startup.
 */
import type { Express } from "express";
import type { BootContext } from "~/server/boot";
import { logger } from "~/lib/observability/logger.server";
import { getAi } from "./registry.server";

export function register(_app: Express, _ctx: BootContext): void {
  try {
    const ai = getAi();
    for (const s of ai.statuses) {
      const fields = {
        capability: s.capability,
        state: s.state,
        model: s.model,
        host: s.host,
        detail: s.detail,
      };
      if (s.state === "misconfigured") logger.warn(fields, "[ai] capability misconfigured");
      else logger.info(fields, "[ai] capability");
    }
    if (ai.embedding) {
      const embedding = ai.embedding;
      const started = Date.now();
      void embedding
        .embed(["ping"], "passage")
        .then((vectors) => {
          logger.info(
            { model: embedding.id, ms: Date.now() - started, width: vectors[0]?.length },
            "[ai] embedding probe ok",
          );
        })
        .catch((e) => {
          logger.warn(
            { model: embedding.id, err: (e as Error).message },
            "[ai] embedding probe failed",
          );
        });
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "[ai] status resolution failed");
  }
}
