/**
 * The indexer: keeps `Chunk` in sync with the domain
 * tables and fills the dense arm via the AI registry when a provider exists.
 *
 * - `reindexSource` rebuilds one source's chunks in a single transaction:
 *   new ordinals are upserted, stale ordinals deleted, and a chunk whose
 *   `contentHash` is unchanged keeps its embedding (a stale model id is left
 *   for `embedPending` to refresh — it matches `embeddingModel <> active`).
 *   Index rows are DERIVED data: written without audit rows.
 * - `reconcileAll` is the sweep: missing/stale sources are reindexed, orphaned
 *   chunks deleted — it is what makes a missed NOTIFY harmless.
 * - `embedPending` embeds `embedding IS NULL OR embeddingModel <> active` in
 *   provider batches OUTSIDE any transaction, writes vectors guarded by
 *   `id + contentHash` (a concurrent rewrite can't be clobbered by a stale
 *   vector), and on provider failure upserts a `SearchIndexJob` with
 *   exponential backoff `min(30 s · 2^attempts, 1 h)`. Not-yet-due jobs are
 *   skipped; with no provider it is a no-op and lexical search still works.
 */
import { Prisma } from "~/generated/prisma/client";
import { db } from "~/lib/db.server";
import { logger } from "~/lib/observability/logger.server";
import { getAi } from "~/lib/ai/registry.server";
import { AiProviderError } from "~/lib/ai/openai-compat.server";
import { prepareChunk, type PreparedChunk } from "./chunking";
import { SOURCE_TYPES, loadSource, listSourceVersions, type SourceType } from "./sources.server";

const EMBED_JOB_OP = "embed";
const JOB_BACKOFF_BASE_MS = 30_000;
const JOB_BACKOFF_MAX_MS = 3_600_000;

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function chunkEqualsRow(
  p: PreparedChunk,
  row: {
    sourceTitle: string;
    ordinal: number;
    headingPath: string[];
    text: string;
    keywords: string;
    tokenCount: number;
    contentHash: string;
    sourceUpdatedAt: Date;
  },
): boolean {
  return (
    p.sourceTitle === row.sourceTitle &&
    p.text === row.text &&
    p.keywords === row.keywords &&
    p.tokenCount === row.tokenCount &&
    p.contentHash === row.contentHash &&
    sameStringArray(p.headingPath, row.headingPath) &&
    p.sourceUpdatedAt.getTime() === row.sourceUpdatedAt.getTime()
  );
}

export async function reindexSource(type: SourceType, id: string): Promise<void> {
  // Chunks of a source type the indexer doesn't own (eval fixtures, foreign
  // corpora) are never touched — an unknown type is not an orphan.
  if (!(SOURCE_TYPES as readonly string[]).includes(type)) return;
  const src = await loadSource(type, id);
  if (!src) {
    await db.$transaction([
      db.chunk.deleteMany({ where: { sourceType: type, sourceId: id } }),
      db.searchIndexJob.deleteMany({ where: { sourceType: type, sourceId: id } }),
    ]);
    return;
  }

  const prepared = src.sections.map((s, ordinal) =>
    prepareChunk({
      sourceType: type,
      sourceId: id,
      sourceTitle: src.title,
      ordinal,
      headingPath: s.headingPath,
      text: s.text,
      sourceUpdatedAt: src.updatedAt,
    }),
  );

  await db.$transaction(async (tx) => {
    const existing = await tx.chunk.findMany({
      where: { sourceType: type, sourceId: id },
      orderBy: { ordinal: "asc" },
    });
    const keep = new Set(prepared.map((p) => p.ordinal));
    const staleIds = existing.filter((e) => !keep.has(e.ordinal)).map((e) => e.id);
    if (staleIds.length) {
      await tx.chunk.deleteMany({ where: { id: { in: staleIds } } });
    }
    for (const p of prepared) {
      const cur = existing.find((e) => e.ordinal === p.ordinal);
      if (!cur) {
        await tx.chunk.create({ data: p });
        continue;
      }
      if (chunkEqualsRow(p, cur)) continue; // idempotent: updatedAt untouched
      await tx.chunk.update({
        where: { id: cur.id },
        data: {
          sourceTitle: p.sourceTitle,
          headingPath: p.headingPath,
          text: p.text,
          keywords: p.keywords,
          tokenCount: p.tokenCount,
          contentHash: p.contentHash,
          sourceUpdatedAt: p.sourceUpdatedAt,
        },
      });
      if (cur.contentHash !== p.contentHash) {
        // The old vector describes old text — clear it so the dense arm never
        // serves a stale embedding; embedPending refills it.
        await tx.$executeRaw`UPDATE "Chunk" SET embedding = NULL, "embeddingModel" = NULL WHERE id = ${cur.id}`;
      }
    }
  });
}

export interface ReconcileReport {
  reindexed: number;
  deletedOrphans: number;
}

/** Reindex missing/stale sources and drop chunks whose source is gone. */
export async function reconcileAll(): Promise<ReconcileReport> {
  const report: ReconcileReport = { reindexed: 0, deletedOrphans: 0 };
  for (const type of SOURCE_TYPES) {
    const versions = await listSourceVersions(type);
    const indexed = await db.chunk.findMany({
      where: { sourceType: type },
      select: { sourceId: true, sourceUpdatedAt: true },
      orderBy: { sourceUpdatedAt: "desc" },
    });
    const maxBySource = new Map<string, Date>();
    for (const row of indexed) {
      if (!maxBySource.has(row.sourceId)) maxBySource.set(row.sourceId, row.sourceUpdatedAt);
    }
    const live = new Set<string>();
    for (const v of versions) {
      live.add(v.id);
      const max = maxBySource.get(v.id);
      if (!max || max.getTime() < v.updatedAt.getTime()) {
        try {
          await reindexSource(type, v.id);
          report.reindexed++;
        } catch (e) {
          logger.warn(
            { err: (e as Error).message, sourceType: type, sourceId: v.id },
            "[search] reconcile reindex failed",
          );
        }
      }
    }
    const orphans = [...maxBySource.keys()].filter((sourceId) => !live.has(sourceId));
    for (const sourceId of orphans) {
      await db.$transaction([
        db.chunk.deleteMany({ where: { sourceType: type, sourceId } }),
        db.searchIndexJob.deleteMany({ where: { sourceType: type, sourceId } }),
      ]);
      report.deletedOrphans++;
    }
  }
  return report;
}

export interface EmbedReport {
  embedded: number;
  failedSources: number;
}

function errorExcerpt(e: unknown): string {
  if (e instanceof AiProviderError) return `${e.message} ${e.bodyExcerpt}`.slice(0, 500);
  return ((e as Error)?.message ?? String(e)).slice(0, 500);
}

/** Record/refresh the retry ledger for one source's `embed` job. */
async function recordEmbedFailure(
  sourceType: string,
  sourceId: string,
  excerpt: string,
): Promise<void> {
  const key = { sourceType, sourceId, op: EMBED_JOB_OP };
  const cur = await db.searchIndexJob.findUnique({
    where: { sourceType_sourceId_op: key },
  });
  const attempts = (cur?.attempts ?? 0) + 1;
  const backoff = Math.min(JOB_BACKOFF_BASE_MS * 2 ** attempts, JOB_BACKOFF_MAX_MS);
  const data = { attempts, lastError: excerpt, nextAttemptAt: new Date(Date.now() + backoff) };
  await db.searchIndexJob.upsert({
    where: { sourceType_sourceId_op: key },
    create: { ...key, ...data },
    update: data,
  });
}

/**
 * Embed pending chunks in one provider call, then write each vector guarded by
 * `id + contentHash`. Returns how many chunks got a (new) vector.
 */
export async function embedPending(opts: { limit?: number } = {}): Promise<EmbedReport> {
  const limit = opts.limit ?? 256;
  const provider = getAi().embedding;
  if (!provider) return { embedded: 0, failedSources: 0 }; // `none`: lexical only

  // Sources with an embed job not yet due are skipped entirely.
  const pendingJobs = await db.searchIndexJob.findMany({
    where: { op: EMBED_JOB_OP, nextAttemptAt: { gt: new Date() } },
    select: { sourceType: true, sourceId: true },
  });
  const blocked = new Set(pendingJobs.map((j) => `${j.sourceType}${j.sourceId}`));

  const pending = await db.$queryRaw<
    {
      id: string;
      sourceType: string;
      sourceId: string;
      text: string;
      sourceTitle: string;
      contentHash: string;
    }[]
  >`SELECT id, "sourceType", "sourceId", text, "sourceTitle", "contentHash"
    FROM "Chunk"
    WHERE (embedding IS NULL OR "embeddingModel" <> ${provider.id})
      AND "sourceType" IN (${Prisma.join(SOURCE_TYPES)})
    ORDER BY "updatedAt" ASC
    LIMIT ${limit}`;

  const targets = pending.filter((c) => !blocked.has(`${c.sourceType}${c.sourceId}`));
  if (!targets.length) return { embedded: 0, failedSources: 0 };

  let vectors: number[][];
  try {
    vectors = await provider.embed(
      targets.map((c) => `${c.sourceTitle}\n${c.text}`),
      "passage",
    );
  } catch (e) {
    const excerpt = errorExcerpt(e);
    const sources = [...new Map(targets.map((c) => [`${c.sourceType}${c.sourceId}`, c])).values()];
    for (const c of sources) {
      await recordEmbedFailure(c.sourceType, c.sourceId, excerpt);
    }
    logger.warn(
      { err: excerpt, sources: sources.length },
      "[search] embedding batch failed — jobs recorded",
    );
    return { embedded: 0, failedSources: sources.length };
  }

  let embedded = 0;
  const touchedSources = new Map<string, { sourceType: string; sourceId: string }>();
  for (let i = 0; i < targets.length; i++) {
    const c = targets[i]!;
    const vec = `[${vectors[i]!.join(",")}]`;
    // Guard on contentHash: a concurrent reindex may have rewritten this chunk
    // while the provider was thinking — a stale vector must never land on it.
    const n = await db.$executeRaw`UPDATE "Chunk"
      SET embedding = ${vec}::vector, "embeddingModel" = ${provider.id}, "updatedAt" = now()
      WHERE id = ${c.id} AND "contentHash" = ${c.contentHash}`;
    if (n > 0) embedded += n;
    touchedSources.set(`${c.sourceType}${c.sourceId}`, c);
  }

  // A source that embedded cleanly clears its retry ledger entry.
  for (const c of touchedSources.values()) {
    await db.searchIndexJob.deleteMany({
      where: { sourceType: c.sourceType, sourceId: c.sourceId, op: EMBED_JOB_OP },
    });
  }
  return { embedded, failedSources: 0 };
}

export interface SourceTypeStats {
  sourceType: string;
  sources: number;
  chunks: number;
  embedded: number;
}

export interface IndexStats {
  activeModel: string | null;
  types: SourceTypeStats[];
  pendingJobs: number;
  failedJobs: number;
  latestErrors: string[];
}

/** Index health for the dashboard card. */
export async function getIndexStats(): Promise<IndexStats> {
  const active = getAi().embedding?.id ?? null;
  const rows = await db.$queryRaw<
    { sourceType: string; sources: bigint; chunks: bigint; embedded: bigint }[]
  >`SELECT "sourceType",
      count(DISTINCT "sourceId") AS sources,
      count(*) AS chunks,
      count(*) FILTER (WHERE "embeddingModel" = ${active}) AS embedded
    FROM "Chunk" GROUP BY "sourceType" ORDER BY "sourceType"`;
  const now = new Date();
  const [pendingJobs, failedJobs, errors] = await Promise.all([
    db.searchIndexJob.count({ where: { nextAttemptAt: { gt: now } } }),
    db.searchIndexJob.count({ where: { nextAttemptAt: { lte: now } } }),
    db.searchIndexJob.findMany({
      where: { lastError: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { sourceType: true, sourceId: true, lastError: true },
    }),
  ]);
  return {
    activeModel: active,
    types: rows.map((r) => ({
      sourceType: r.sourceType,
      sources: Number(r.sources),
      chunks: Number(r.chunks),
      embedded: Number(r.embedded),
    })),
    pendingJobs,
    failedJobs,
    latestErrors: errors.map((e) => `${e.sourceType}/${e.sourceId}: ${e.lastError}`),
  };
}

/** The recent failed retry-ledger rows for `/admin/index`. */
export async function listFailedIndexJobs(limit = 10) {
  return db.searchIndexJob.findMany({
    where: { lastError: { not: null } },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      sourceType: true,
      sourceId: true,
      attempts: true,
      lastError: true,
      nextAttemptAt: true,
    },
  });
}

/**
 * Clear every vector + `embeddingModel` stamp so `embedPending` re-embeds the
 * corpus against the active provider. Both must go: the pending predicate is
 * `embedding IS NULL OR "embeddingModel" <> active`, and `NULL <> x` is NULL —
 * a stamp-less row that kept its vector would never re-embed. Scoped to the
 * known source types; the dense arm only serves the active model meanwhile.
 */
export async function clearEmbeddingModels(): Promise<void> {
  await db.$executeRaw`UPDATE "Chunk" SET embedding = NULL, "embeddingModel" = NULL
    WHERE "sourceType" IN (${Prisma.join(SOURCE_TYPES)})`;
}
