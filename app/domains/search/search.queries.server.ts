import { getAi } from "~/lib/ai/registry.server";
import { hybridSearch, type HybridSearchOptions } from "~/lib/search/query.server";

export async function searchWorkspace(q: string, options: HybridSearchOptions = {}) {
  return {
    ...(await hybridSearch(q, options)),
    semantic: getAi().embedding !== null,
    candidateLimit: 50,
  };
}
