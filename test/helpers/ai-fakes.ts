/**
 * Deterministic AI fakes for `pnpm test` — no network, no models.
 *
 * `hashEmbedder` maps every lower-cased word to one of 1024 buckets by a stable
 * FNV-1a hash and L2-normalises — lexical overlap is the only signal.
 * `conceptEmbedder` maps words → concepts via the eval fixture's `CONCEPTS`
 * table, so two texts sharing a concept but no word are still close — the
 * pipeline test gets a "dense" arm without a model. A text with no concept
 * words gets a zero-safe tiny constant vector (a zero vector would make every
 * cosine distance NaN).
 */
import { CONCEPTS } from "../fixtures/retrieval-eval";
import type { ChatMessage, EmbeddingProvider, GenerationProvider } from "~/lib/ai/types";

const DIMS = 1024;

/** FNV-1a over UTF-16 code units — stable across runs and platforms. */
function stableHash(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function l2(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map((x) => x / norm);
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export const hashEmbedder: EmbeddingProvider = {
  id: "fake-hash@1024",
  dimensions: DIMS,
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array<number>(DIMS).fill(0);
      for (const w of wordsOf(text)) v[stableHash(w) % DIMS] += 1;
      return l2(v);
    });
  },
};

/** surface form → concept, once. */
const WORD_TO_CONCEPT = new Map<string, string>();
const CONCEPT_BUCKET = new Map<string, number>();
for (const [concept, forms] of Object.entries(CONCEPTS)) {
  CONCEPT_BUCKET.set(concept, stableHash(concept) % DIMS);
  for (const form of forms) WORD_TO_CONCEPT.set(form, concept);
}

/** Uniform 1e-3 direction — never NaN, never a strong match on anything. */
const EMPTY_VECTOR = l2(new Array<number>(DIMS).fill(1e-3));

export const conceptEmbedder: EmbeddingProvider = {
  id: "fake-concept@1024",
  dimensions: DIMS,
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array<number>(DIMS).fill(0);
      let hit = false;
      for (const w of wordsOf(text)) {
        const concept = WORD_TO_CONCEPT.get(w);
        if (concept) {
          v[CONCEPT_BUCKET.get(concept)!] += 1;
          hit = true;
        }
      }
      return hit ? l2(v) : EMPTY_VECTOR;
    });
  },
};

/** Scripted streaming generator — yields the answer in fixed chunks. */
export function fakeGenerator(chunks: string[], id = "fake-generation"): GenerationProvider {
  return {
    id,
    async *generate(_messages: ChatMessage[]) {
      for (const chunk of chunks) yield chunk;
    },
  };
}
