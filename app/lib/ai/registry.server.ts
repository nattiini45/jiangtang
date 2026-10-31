/**
 * `getAi()` — the one place the app resolves its providers. Lazily built
 * once per process from `readAiConfig(process.env)`; a `none` embedding or
 * generation capability yields `null` (no dense arm / no answers), while a
 * `none` reranker is the pass-through so the pipeline always has a ranker.
 *
 * `setAiForTests` / `resetAi` let tests swap in the deterministic fakes
 * (`test/helpers/ai-fakes.ts`) without env manipulation.
 */
import { readAiConfig } from "./config.server";
import { createEmbeddingProvider } from "./embedding.server";
import { createGenerationProvider } from "./generation.server";
import { createRerankerProvider, passthroughReranker } from "./reranker.server";
import type {
  CapabilityStatus,
  EmbeddingProvider,
  GenerationProvider,
  RerankerProvider,
} from "./types";

export interface AiRegistry {
  embedding: EmbeddingProvider | null;
  reranker: RerankerProvider;
  generation: GenerationProvider | null;
  statuses: CapabilityStatus[];
}

let cached: AiRegistry | null = null;

function build(): AiRegistry {
  const cfg = readAiConfig(process.env);
  return {
    embedding: cfg.embedding.state === "api" ? createEmbeddingProvider(cfg.embedding.config) : null,
    reranker:
      cfg.reranker.state === "api"
        ? createRerankerProvider(cfg.reranker.config)
        : passthroughReranker,
    generation:
      cfg.generation.state === "api" ? createGenerationProvider(cfg.generation.config) : null,
    statuses: cfg.statuses,
  };
}

export function getAi(): AiRegistry {
  cached ??= build();
  return cached;
}

/** Test seam: merge an override onto the resolved registry. */
export function setAiForTests(override: Partial<AiRegistry>): void {
  cached = { ...getAi(), ...override };
}

export function resetAi(): void {
  cached = null;
}
