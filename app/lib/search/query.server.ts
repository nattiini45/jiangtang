/**
 * Hybrid recall + rerank (stages 2–3 of the retrieval pipeline).
 *
 * Four recall arms, each returning ≤ 50 chunk rows in rank order:
 *   and    tsv @@ (websearch_to_tsquery('simple') || websearch_to_tsquery('german'))
 *   or     the same lexemes OR-ed — "Garantie Yamaha Mischpult" still reaches
 *          a doc that only says „Digitalmischpult"
 *   fuzzy  pg_trgm word_similarity on text/sourceTitle — mistyped serials
 *   dense  pgvector cosine, only when an embedding provider is configured
 *          (`SET LOCAL hnsw.ef_search = 100` inside the read transaction)
 *
 * RRF (k = 60) fuses chunk ranks — arms are on incomparable scales, so ranks
 * are the only honest input. The fused list collapses to sources (a source's
 * score is its best chunk's; the best chunk is the citation, up to two more
 * ordinals are remembered for the answer's context assembly), then the reranker
 * scores the top 50 and `limit` survive. A failing arm or reranker is logged,
 * skipped/pass-through, and named in `degraded` — never thrown.
 */
import { Prisma } from "~/generated/prisma/client";
import { db } from "~/lib/db.server";
import { logger } from "~/lib/observability/logger.server";
import { getAi } from "~/lib/ai/registry.server";
import { entityHref } from "~/lib/entity-links";
import type { EntityType } from "~/lib/realtime/events";
import { SOURCE_TO_ENTITY, type SourceType } from "./sources.server";

const ARM_LIMIT = 50;
const RRF_K = 60;
const RERANK_DEPTH = 50;
const RERANK_DOC_CHARS = 1500;

export type SearchArm = "and" | "or" | "fuzzy" | "dense";

export interface SearchHit {
  sourceType: string;
  sourceId: string;
  /** Ordinal of the cited (best-scoring) chunk. */
  ordinal: number;
  title: string;
  /** Plain-text snippet (headline or lead-in). */
  snippet: string;
  /** The snippet as safe HTML — escaped, with matches wrapped in <mark>. */
  snippetHtml: string;
  href: string | null;
  /** RRF score — arms contribute 1/(60 + rank), the reranker only reorders. */
  score: number;
  /** The arms that hit the cited chunk. */
  arms: SearchArm[];
  /** Up to 2 more chunk ordinals of this source, next-best first (answer context). */
  moreOrdinals: number[];
}

export interface HybridSearchOptions {
  limit?: number;
  sourceTypes?: string[];
}

export interface HybridSearchResult {
  results: SearchHit[];
  /** Arms/stages that failed (e.g. "dense", "reranker") — absent providers are not listed. */
  degraded: string[];
}

interface ChunkRow {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceTitle: string;
  ordinal: number;
  text: string;
}

const CHUNK_COLS = `id, "sourceType", "sourceId", "sourceTitle", ordinal, text`;

function typeFilter(sourceTypes?: string[]): Prisma.Sql {
  return sourceTypes?.length
    ? Prisma.sql`AND "sourceType" IN (${Prisma.join(sourceTypes)})`
    : Prisma.empty;
}

async function armAnd(q: string, filter: Prisma.Sql): Promise<ChunkRow[]> {
  return db.$queryRaw<ChunkRow[]>`
    SELECT ${Prisma.raw(CHUNK_COLS)} FROM "Chunk"
    WHERE tsv @@ (
      websearch_to_tsquery('simple', ${q}) || websearch_to_tsquery('german', ${q})
    ) ${filter}
    ORDER BY ts_rank_cd(tsv,
      websearch_to_tsquery('simple', ${q}) || websearch_to_tsquery('german', ${q})
    ) DESC
    LIMIT ${ARM_LIMIT}`;
}

async function armOr(q: string, filter: Prisma.Sql): Promise<ChunkRow[]> {
  return db.$queryRaw<ChunkRow[]>`
    SELECT ${Prisma.raw(CHUNK_COLS)} FROM "Chunk"
    WHERE tsv @@ (
      replace(plainto_tsquery('simple', ${q})::text, '&', '|')::tsquery ||
      replace(plainto_tsquery('german', ${q})::text, '&', '|')::tsquery
    ) ${filter}
    ORDER BY ts_rank_cd(tsv,
      replace(plainto_tsquery('simple', ${q})::text, '&', '|')::tsquery ||
      replace(plainto_tsquery('german', ${q})::text, '&', '|')::tsquery
    ) DESC
    LIMIT ${ARM_LIMIT}`;
}

async function armFuzzy(q: string, filter: Prisma.Sql): Promise<ChunkRow[]> {
  return db.$queryRaw<ChunkRow[]>`
    SELECT ${Prisma.raw(CHUNK_COLS)} FROM "Chunk"
    WHERE (${q} <% "text" OR ${q} <% "sourceTitle") ${filter}
    ORDER BY greatest(word_similarity(${q}, "text"), word_similarity(${q}, "sourceTitle")) DESC
    LIMIT ${ARM_LIMIT}`;
}

async function armDense(
  q: string,
  filter: Prisma.Sql,
): Promise<{ rows: ChunkRow[]; error: unknown | null }> {
  const provider = getAi().embedding;
  if (!provider) return { rows: [], error: null };
  try {
    const [vec] = await provider.embed([q], "query");
    if (!vec?.length) return { rows: [], error: null };
    const lit = `[${vec.join(",")}]`;
    // ef_search is per-transaction — SET LOCAL scopes it to this read.
    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL hnsw.ef_search = 100`;
      return tx.$queryRaw<ChunkRow[]>`
        SELECT ${Prisma.raw(CHUNK_COLS)} FROM "Chunk"
        WHERE embedding IS NOT NULL AND "embeddingModel" = ${provider.id} ${filter}
        ORDER BY embedding <=> ${lit}::vector
        LIMIT ${ARM_LIMIT}`;
    });
    return { rows, error: null };
  } catch (e) {
    return { rows: [], error: e };
  }
}

function errorText(e: unknown): string {
  return ((e as Error)?.message ?? String(e)).slice(0, 300);
}

/** Resolve hrefs — `project` and `room` are slug-routed, so they need a lookup. */
async function resolveHrefs(
  sources: { sourceType: string; sourceId: string }[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const projectIds = sources.filter((s) => s.sourceType === "PROJECT").map((s) => s.sourceId);
  const roomIds = sources.filter((s) => s.sourceType === "ROOM").map((s) => s.sourceId);
  const slugs = new Map<string, string>();
  if (projectIds.length) {
    for (const p of await db.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, slug: true },
    })) {
      slugs.set(p.id, p.slug);
    }
  }
  if (roomIds.length) {
    for (const r of await db.room.findMany({
      where: { id: { in: roomIds } },
      select: { id: true, slug: true },
    })) {
      slugs.set(r.id, r.slug);
    }
  }
  for (const s of sources) {
    const entity = SOURCE_TO_ENTITY[s.sourceType as SourceType] as EntityType | undefined;
    out.set(
      `${s.sourceType}:${s.sourceId}`,
      entity ? entityHref(entity, { id: s.sourceId, slug: slugs.get(s.sourceId) }) : null,
    );
  }
  return out;
}

export async function hybridSearch(
  raw: string,
  opts: HybridSearchOptions = {},
): Promise<HybridSearchResult> {
  const limit = opts.limit ?? 8;
  const q = raw.trim().replace(/\s+/g, " ");
  if (!q) return { results: [], degraded: [] };

  const filter = typeFilter(opts.sourceTypes);
  const degraded: string[] = [];

  const [andRows, orRows, fuzzyRows, dense] = await Promise.all([
    armAnd(q, filter),
    armOr(q, filter),
    q.length >= 3 ? armFuzzy(q, filter) : Promise.resolve([]),
    armDense(q, filter),
  ]);
  if (dense.error) {
    logger.warn({ err: errorText(dense.error) }, "[search] dense arm failed — skipped");
    degraded.push("dense");
  }

  const arms: Record<SearchArm, ChunkRow[]> = {
    and: andRows,
    or: orRows,
    fuzzy: fuzzyRows,
    dense: dense.rows,
  };

  // RRF over chunk ids; a chunk remembers which arms hit it.
  interface Fused {
    row: ChunkRow;
    score: number;
    arms: Set<SearchArm>;
  }
  const chunks = new Map<string, Fused>();
  for (const [arm, rows] of Object.entries(arms) as [SearchArm, ChunkRow[]][]) {
    rows.forEach((row, i) => {
      const cur = chunks.get(row.id) ?? { row, score: 0, arms: new Set<SearchArm>() };
      cur.score += 1 / (RRF_K + i + 1);
      cur.arms.add(arm);
      chunks.set(row.id, cur);
    });
  }
  if (!chunks.size) return { results: [], degraded };

  // Collapse to sources: score = best chunk's score; best chunk is the citation.
  interface SourceAgg {
    sourceType: string;
    sourceId: string;
    score: number;
    best: Fused;
    moreOrdinals: number[];
  }
  const bySource = new Map<string, SourceAgg>();
  for (const f of [...chunks.values()].sort((a, b) => b.score - a.score)) {
    const key = `${f.row.sourceType}:${f.row.sourceId}`;
    const cur = bySource.get(key);
    if (!cur) {
      bySource.set(key, {
        sourceType: f.row.sourceType,
        sourceId: f.row.sourceId,
        score: f.score,
        best: f,
        moreOrdinals: [],
      });
    } else if (cur.moreOrdinals.length < 2 && f.row.ordinal !== cur.best.row.ordinal) {
      cur.moreOrdinals.push(f.row.ordinal);
    }
  }
  let candidates = [...bySource.values()].sort((a, b) => b.score - a.score).slice(0, RERANK_DEPTH);

  // Stage 3 — cross-encoder rerank (pass-through provider keeps fused order).
  try {
    const docs = candidates.map((c) =>
      `${c.best.row.sourceTitle}\n${c.best.row.text}`.slice(0, RERANK_DOC_CHARS),
    );
    const ranked = await getAi().reranker.rerank(q, docs);
    const scoreByIndex = new Map(ranked.map((r) => [r.index, r.score]));
    candidates = candidates
      .map((c, index) => ({ c, s: scoreByIndex.get(index) ?? 0 }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  } catch (e) {
    logger.warn({ err: errorText(e) }, "[search] reranker failed — fused order kept");
    degraded.push("reranker");
  }

  const top = candidates.slice(0, limit);

  // Snippets + hrefs for the survivors only. ts_headline does NOT escape its
  // input, and chunk text is user content — so the match markers are control
  // characters (impossible in normal text): escape the headline wholesale, then
  // turn the sentinels into <mark>. A literal "<b>" in a note stays text.
  const SEL_OPEN = "\u0001";
  const SEL_CLOSE = "\u0002";
  const headlineOpts = `MaxWords=30, MinWords=10, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … ", StartSel=${SEL_OPEN}, StopSel=${SEL_CLOSE}`;
  const ids = top.map((c) => c.best.row.id);
  const heads = await db.$queryRaw<{ id: string; head: string | null; lead: string }[]>`
    SELECT id,
      ts_headline('german', text, (
        replace(plainto_tsquery('simple', ${q})::text, '&', '|')::tsquery ||
        replace(plainto_tsquery('german', ${q})::text, '&', '|')::tsquery
      ), ${headlineOpts}) AS head,
      left(text, 200) AS lead
    FROM "Chunk" WHERE id IN (${Prisma.join(ids)})`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const snippetById = new Map(
    heads.map((h) => {
      const head = h.head?.trim() ? h.head : h.lead;
      return [
        h.id,
        {
          text: head.replaceAll(SEL_OPEN, "").replaceAll(SEL_CLOSE, "").trim(),
          html: esc(head).replaceAll(SEL_OPEN, "<mark>").replaceAll(SEL_CLOSE, "</mark>"),
        },
      ];
    }),
  );
  const hrefs = await resolveHrefs(
    top.map((c) => ({ sourceType: c.sourceType, sourceId: c.sourceId })),
  );

  return {
    results: top.map((c) => ({
      sourceType: c.sourceType,
      sourceId: c.sourceId,
      ordinal: c.best.row.ordinal,
      title: c.best.row.sourceTitle,
      snippet: snippetById.get(c.best.row.id)?.text ?? c.best.row.text.slice(0, 200),
      snippetHtml: snippetById.get(c.best.row.id)?.html ?? esc(c.best.row.text.slice(0, 200)),
      href: hrefs.get(`${c.sourceType}:${c.sourceId}`) ?? null,
      score: c.score,
      arms: [...c.best.arms],
      moreOrdinals: c.moreOrdinals,
    })),
    degraded,
  };
}
