/**
 * Reranker seam: `api` → `POST {base}/rerank` with
 * `{ model, query, documents, top_n }`, accepting `results[].index` scored via
 * `relevance_score` or `score` (Cohere vs. Jina/vLLM spellings).
 * `none` → pass-through: input order with descending synthetic scores, so the
 * hybrid pipeline always gets a ranked list it can trust.
 */
import { postJson } from "./openai-compat.server";
import type { RerankerConfig } from "./config.server";
import type { RerankerProvider } from "./types";

const TIMEOUT_MS = 15_000;

interface RerankResponse {
  results?: Array<{ index: number; relevance_score?: number; score?: number }>;
}

export const passthroughReranker: RerankerProvider = {
  id: "none",
  async rerank(_query, docs) {
    return docs.map((_, index) => ({ index, score: docs.length - index }));
  },
};

export function createRerankerProvider(cfg: RerankerConfig): RerankerProvider {
  return {
    id: `${cfg.model}@api`,
    async rerank(query, docs) {
      const res = (await postJson(`${cfg.baseUrl}/rerank`, {
        apiKey: cfg.apiKey,
        timeoutMs: TIMEOUT_MS,
        body: { model: cfg.model, query, documents: docs, top_n: docs.length },
      })) as RerankResponse;
      if (!Array.isArray(res.results)) return passthroughReranker.rerank(query, docs);
      return res.results.map((r) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }));
    },
  };
}
