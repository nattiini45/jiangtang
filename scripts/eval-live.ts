/**
 * `pnpm eval:live` — the retrieval-eval fixture against the CONFIGURED
 * real providers. Same corpus and queries as `test/retrieval-eval.test.ts`,
 * but chunks land under source type `EVAL_LIVE` and embed through the API
 * embedding provider in `.env`. Requires EMBEDDING_BASE_URL; the reranker is
 * the configured one when present, pass-through otherwise. Prints the top-3
 * hit rate per query kind plus MRR, and always cleans up its chunks.
 *
 * Not part of `pnpm test` — it needs real endpoints by design.
 */
try {
  process.loadEnvFile();
} catch {
  // no .env — environment must be set externally
}

if (!process.env.EMBEDDING_BASE_URL) {
  console.error("eval:live: EMBEDDING_BASE_URL ist nicht gesetzt — Abbruch.");
  process.exit(1);
}

const { db } = await import("~/lib/db.server");
const { getAi } = await import("~/lib/ai/registry.server");
const { hybridSearch } = await import("~/lib/search/query.server");
const { chunkMarkdown, prepareChunk } = await import("~/lib/search/chunking");
const { EVAL_DOCS, EVAL_QUERIES } = await import("../test/fixtures/retrieval-eval");

const SOURCE_TYPE = "EVAL_LIVE";

async function main() {
  const ai = getAi();
  if (!ai.embedding) {
    console.error("eval:live: kein Embedding-Provider aktiv — Status:", ai.statuses);
    process.exit(1);
  }
  console.info(`eval:live — embedding=${ai.embedding.id}, reranker=${ai.reranker.id}`);

  // Chunk + embed the fixture corpus through the same path as the indexer.
  const rows: { id: string; sourceTitle: string; text: string }[] = [];
  for (const doc of EVAL_DOCS) {
    for (const [ordinal, section] of chunkMarkdown(doc.text).entries()) {
      const prepared = prepareChunk({
        sourceType: SOURCE_TYPE,
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
  const vectors = await ai.embedding.embed(
    rows.map((r) => `${r.sourceTitle}\n${r.text}`),
    "passage",
  );
  for (const [i, row] of rows.entries()) {
    await db.$executeRaw`UPDATE "Chunk"
      SET embedding = ${`[${vectors[i]!.join(",")}]`}::vector, "embeddingModel" = ${ai.embedding!.id}
      WHERE id = ${row.id}`;
  }
  console.info(`indexed ${rows.length} chunks from ${EVAL_DOCS.length} docs\n`);

  console.info("query\tkind\trank\tmrr\tarms");
  const byKind = new Map<string, { hits: number; total: number }>();
  let rrSum = 0;
  for (const { q, kind, expect: expected } of EVAL_QUERIES) {
    const { results, degraded } = await hybridSearch(q, { sourceTypes: [SOURCE_TYPE] });
    const idx = results.findIndex((r) => r.sourceId === expected);
    const rank = idx === -1 ? 0 : idx + 1;
    const rr = rank > 0 ? 1 / rank : 0;
    rrSum += rr;
    const arms = idx === -1 ? "-" : results[idx]!.arms.join("+");
    console.info(
      `${JSON.stringify(q)}\t${kind}\t${rank || "-"}\t${rr.toFixed(2)}\t${arms}${degraded.length ? `  [degraded: ${degraded.join(",")}]` : ""}`,
    );
    const bucket = byKind.get(kind) ?? { hits: 0, total: 0 };
    bucket.total += 1;
    if (rank >= 1 && rank <= 3) bucket.hits += 1;
    byKind.set(kind, bucket);
  }

  console.info("\ntop-3 hit rate by kind:");
  for (const [kind, { hits, total }] of byKind) {
    console.info(`  ${kind.padEnd(11)} ${hits}/${total}  (${((hits / total) * 100).toFixed(0)}%)`);
  }
  console.info(`MRR: ${(rrSum / EVAL_QUERIES.length).toFixed(3)}`);
}

try {
  await main();
} finally {
  await db.chunk.deleteMany({ where: { sourceType: SOURCE_TYPE } });
  await db.$disconnect();
}

export {};
