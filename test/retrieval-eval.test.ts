import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { resetAi, setAiForTests } from "~/lib/ai/registry.server";
import { conceptEmbedder } from "./helpers/ai-fakes";
import type { RerankerProvider } from "~/lib/ai/types";
import { EVAL_DOCS, EVAL_QUERIES } from "./fixtures/retrieval-eval";
import { chunkMarkdown, prepareChunk } from "~/lib/search/chunking";
import { hybridSearch } from "~/lib/search/query.server";

/**
 * The retrieval eval. Every EVAL_DOCS entry becomes real Chunk rows
 * through `prepareChunk` under its own source type `EVAL` (the dev corpus
 * can't interfere — hybridSearch is scoped by sourceTypes), embedded with the
 * deterministic `conceptEmbedder` so paraphrase queries exercise the dense
 * ARM (fusion carrying a dense-only hit into the top 3), not a model's
 * quality. The isolation case asserts the fixture still isolates the dense arm:
 * without an embedding provider, no paraphrase may reach the top 3 — if one
 * does, that is a fixture finding for the author, not something to tune.
 */

const passThrough: RerankerProvider = {
  id: "pass-through",
  async rerank(_query, docs) {
    return docs.map((_, index) => ({ index, score: docs.length - index }));
  },
};

beforeAll(async () => {
  const rows: { id: string; sourceTitle: string; text: string }[] = [];
  for (const doc of EVAL_DOCS) {
    for (const [ordinal, section] of chunkMarkdown(doc.text).entries()) {
      const prepared = prepareChunk({
        sourceType: "EVAL",
        sourceId: doc.id,
        sourceTitle: doc.title,
        ordinal,
        headingPath: section.headingPath,
        text: section.text,
        sourceUpdatedAt: new Date(),
      });
      const created = await db.chunk.create({ data: prepared });
      rows.push({ id: created.id, sourceTitle: doc.title, text: section.text });
    }
  }
  const vectors = await conceptEmbedder.embed(
    rows.map((r) => `${r.sourceTitle}\n${r.text}`),
    "passage",
  );
  for (const [i, row] of rows.entries()) {
    await db.$executeRaw`UPDATE "Chunk"
      SET embedding = ${`[${vectors[i]!.join(",")}]`}::vector, "embeddingModel" = ${conceptEmbedder.id}
      WHERE id = ${row.id}`;
  }
});

afterAll(async () => {
  resetAi();
  await db.chunk.deleteMany({ where: { sourceType: "EVAL" } });
});

describe("retrieval eval", () => {
  it("every query's expected source lands in the top 3", async () => {
    setAiForTests({ embedding: conceptEmbedder, reranker: passThrough, generation: null });
    const failures: string[] = [];
    console.info("\nquery\t\tkind\trank\tarms");
    for (const { q, kind, expect: expected } of EVAL_QUERIES) {
      const { results } = await hybridSearch(q, { sourceTypes: ["EVAL"] });
      const idx = results.findIndex((r) => r.sourceId === expected);
      const rank = idx === -1 ? 0 : idx + 1;
      const arms = idx === -1 ? "-" : results[idx]!.arms.join("+");
      console.info(`${JSON.stringify(q)}\t${kind}\t${rank}\t${arms}`);
      if (rank === 0 || rank > 3)
        failures.push(`${q} → expect ${expected}, got rank ${rank || "none"}`);
    }
    expect(failures).toEqual([]);
  });

  it("keeps paraphrase queries out of the top 3 with the dense arm off", async () => {
    setAiForTests({ embedding: null, reranker: passThrough, generation: null });
    for (const { q, kind, expect: expected } of EVAL_QUERIES) {
      if (kind !== "paraphrase") continue;
      const { results } = await hybridSearch(q, { sourceTypes: ["EVAL"] });
      const idx = results.findIndex((r) => r.sourceId === expected);
      const rank = idx === -1 ? 0 : idx + 1;
      expect(rank === 0 || rank > 3, `fixture no longer isolates the dense arm: ${q}`).toBe(true);
    }
  });
});
