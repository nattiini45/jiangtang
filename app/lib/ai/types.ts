/**
 * The AI seams — three provider interfaces, resolved from the environment at
 * boot. A capability resolves to `api` when a valid endpoint and model are
 * configured, to `none` when nothing is configured, and to `misconfigured` for
 * partial or invalid configuration, which is reported at boot. `none` embedding
 * or generation yields no provider, while a `none` reranker falls back to a
 * pass-through.
 */

/** One chat message for the generation seam. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** the query side carries the task instruction, the passage side does not. */
export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(texts: string[], kind: "query" | "passage"): Promise<number[][]>;
}

export interface RerankerProvider {
  readonly id: string;
  rerank(query: string, docs: string[]): Promise<Array<{ index: number; score: number }>>;
}

export interface GenerationProvider {
  readonly id: string;
  /** Streamed — yields the deltas of one completion. */
  generate(messages: ChatMessage[]): AsyncIterable<string>;
}

/**
 * Per-capability resolution outcome, logged at boot ("each failure is
 * logged at boot"). `host` carries the endpoint's hostname only — never a full
 * URL with credentials, and keys never reach a log line or an error message.
 */
export interface CapabilityStatus {
  capability: "embedding" | "reranker" | "generation";
  state: "api" | "none" | "misconfigured";
  model?: string;
  host?: string;
  detail?: string;
}
