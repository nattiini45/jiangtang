/**
 * `api`-tier EmbeddingProvider: OpenAI-compatible
 * `POST {base}/embeddings`.
 *
 * - `id` is `<model>@1024` — the dense column is `vector(1024)` for the life of
 *   the database, and the provider id feeds `Chunk.embeddingModel`.
 * - `kind` selects the configured template for that side. Defaults are the
 *   Qwen3 query template (`Instruct: {instruction}\n` `Query:{text}` — no
 *   space after `Query:`) and the plain `{text}` passage template.
 * - Batches of 32. `dimensions: 1024` is sent unless `EMBEDDING_SEND_DIMENSIONS`
 *   is off; a 400 whose body mentions "dimension" retries that batch once
 *   without it (older endpoints reject the parameter) and logs once.
 * - Returned vectors longer than 1024 are truncated and L2-normalised
 *   (Matryoshka); shorter or non-finite is an error — a wrong-width
 *   insert would fail at the column anyway, and failing early names the cause.
 */
import { logger } from "~/lib/observability/logger.server";
import { tr } from "~/i18n/request-locale.server";
import { AiProviderError, postJson } from "./openai-compat.server";
import type { EmbeddingConfig } from "./config.server";
import type { EmbeddingProvider } from "./types";

const TIMEOUT_MS = 30_000;
const BATCH = 32;

interface EmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
}

/**
 * Fit a provider vector to the column: truncate-and-renormalise over 1024,
 * error under it or on non-finite values. The L2 normalisation also runs on
 * exact-width vectors — cosine distance is scale-invariant, so the unit norm
 * is free and keeps magnitudes uniform in the index.
 */
function fitDimensions(raw: number[], dimensions: number): number[] {
  if (raw.some((x) => !Number.isFinite(x))) {
    throw new AiProviderError(tr("places.err.ai.embeddingNonFinite"), null, "");
  }
  let v = raw;
  if (v.length < dimensions) {
    throw new AiProviderError(
      tr("places.err.ai.embeddingTooShort", { length: v.length, dimensions }),
      null,
      "",
    );
  }
  if (v.length > dimensions) v = v.slice(0, dimensions);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

export function createEmbeddingProvider(cfg: EmbeddingConfig): EmbeddingProvider {
  const applyTemplate = (text: string, kind: "query" | "passage"): string =>
    (kind === "query" ? cfg.queryTemplate : cfg.passageTemplate)
      .replace("{instruction}", cfg.queryInstruction)
      .replace("{text}", text);

  async function embedBatch(input: string[]): Promise<EmbeddingResponse> {
    const payload: Record<string, unknown> = { model: cfg.model, input };
    if (cfg.sendDimensions) payload.dimensions = cfg.dimensions;
    try {
      return (await postJson(`${cfg.baseUrl}/embeddings`, {
        apiKey: cfg.apiKey,
        timeoutMs: TIMEOUT_MS,
        body: payload,
      })) as EmbeddingResponse;
    } catch (e) {
      // Some OpenAI-compatible servers reject an unknown `dimensions` field —
      // retry this batch once without it, and say so once per occurrence.
      if (
        e instanceof AiProviderError &&
        e.status === 400 &&
        /dimension/i.test(e.bodyExcerpt) &&
        cfg.sendDimensions
      ) {
        logger.warn(
          { model: cfg.model },
          "[ai] endpoint lehnt `dimensions` ab — Wiederholung ohne den Parameter",
        );
        delete payload.dimensions;
        return (await postJson(`${cfg.baseUrl}/embeddings`, {
          apiKey: cfg.apiKey,
          timeoutMs: TIMEOUT_MS,
          body: payload,
        })) as EmbeddingResponse;
      }
      throw e;
    }
  }

  return {
    id: `${cfg.model}@${cfg.dimensions}`,
    dimensions: cfg.dimensions,
    async embed(texts, kind) {
      const out: number[][] = new Array(texts.length);
      for (let offset = 0; offset < texts.length; offset += BATCH) {
        const input = texts.slice(offset, offset + BATCH).map((t) => applyTemplate(t, kind));
        const res = await embedBatch(input);
        if (!Array.isArray(res.data)) {
          throw new AiProviderError(tr("places.err.ai.embeddingNoData"), null, "");
        }
        for (const item of res.data) {
          out[offset + item.index] = fitDimensions(item.embedding, cfg.dimensions);
        }
      }
      for (let i = 0; i < out.length; i++) {
        if (!out[i])
          throw new AiProviderError(
            tr("places.err.ai.embeddingMissingIndex", { index: i }),
            null,
            "",
          );
      }
      return out;
    },
  };
}
