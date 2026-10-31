-- Functional baseline, file 5 of 7: search indexes.
--
-- Responsibility: the five search objects on "Chunk" that Prisma cannot model,
-- and which 20261023000100_core_schema therefore left out: the stored generated
-- tsvector column `tsv`, the cosine HNSW index over the dense embedding, and
-- the three GIN indexes (one lexeme arm, two trigram arms).
--
-- `tsv` is added here, not in core_schema, and is therefore appended to the end
-- of the table. That reproduces the reference column order exactly: the catalog
-- records `tsv` at attnum 16 on a "Chunk" whose live columns are numbered 1..16
-- with no gap, so attnum 16 is the last position and an ALTER TABLE ... ADD
-- COLUMN lands on it. core_schema defines exactly 15 columns (id .. updatedAt),
-- 15 + 1 = 16, so the file 2 / file 5 split reproduces the reference ordinals.
--
-- The generation expression is the catalog's recorded generation_expr, written
-- with its explicit regconfig and ::text casts rather than the terser literals
-- the historical chain used. The difference is casting only - an unadorned
-- 'simple' resolves to regconfig through to_tsvector's signature - so the
-- stored expression is the same; the form written here is the one the capture
-- measures, which lets the self-check compare text instead of asserting an
-- equivalence it cannot execute.
--
-- Four weighted arms, in this order:
--   A  simple  "sourceTitle"           identifiers in a title keep their shape
--   A  german  "sourceTitle"           prose in a title, stemmed
--   B  german  text                    prose in the body, stemmed
--   C  simple  text + keywords         identifiers living in the body
-- Both text search configurations are named explicitly. A bare to_tsvector()
-- would follow the server's default_text_search_config, which is installation
-- state and not part of this migration; the reference object names 'simple' and
-- 'german', so this one does too.
--
-- "embedding" stays vector(1024) and is created by core_schema; this file only
-- indexes it. `tsv` is nullable and generated: callers never write it, and its
-- value is always produced by the expression below.
--
-- The four indexes carry exactly the method, expression and operator class the
-- catalog records, and nothing else: no INCLUDE columns, no predicates, no
-- tablespace, and no reloptions - in particular the HNSW index holds no
-- `m` / `ef_construction` options, so no WITH clause is emitted. ef_search is a
-- per-session runtime setting in the reference, not an index option, and is not
-- set here. vector_cosine_ops and gin_trgm_ops resolve to their public-schema
-- extensions installed by file 1 (vector, pg_trgm).
--
-- Deliberately absent from this file, by design:
--   * the two CREATE EXTENSION statements for vector and pg_trgm (both written
--     verbatim into file 1) - file 1 owns every extension, and this file must
--     not create one;
--   * the creation of "Chunk" itself, its primary key, and its two btree indexes
--     Chunk_sourceType_sourceId_idx and Chunk_sourceType_sourceId_ordinal_key -
--     file 2 writes them, and the ordinal key is the table's unique index, not a
--     search index;
--   * IF NOT EXISTS guards on the column or the indexes - a fresh install has
--     neither, and a guard would silently accept a conflicting pre-existing
--     object;
--   * any drop, rename, recreate or ALTER of these five objects. Each is created
--     exactly once, in the text this file carries as the final state, and the
--     object matrix records altered_after_creation = false
--     for all four indexes and for the column. The statements that
--     `prisma migrate diff` re-proposes on every run (DROP INDEX on the four
--     indexes, ALTER COLUMN "tsv" DROP DEFAULT) are recorded residuals, not
--     history, and are omitted here as they were omitted there.

-- ===========================================================================
-- Generated search vector
-- ===========================================================================

ALTER TABLE "Chunk" ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS
    (((setweight(to_tsvector('simple'::regconfig, COALESCE("sourceTitle", ''::text)), 'A'::"char")
       || setweight(to_tsvector('german'::regconfig, COALESCE("sourceTitle", ''::text)), 'A'::"char"))
      || setweight(to_tsvector('german'::regconfig, COALESCE(text, ''::text)), 'B'::"char"))
     || setweight(to_tsvector('simple'::regconfig, ((COALESCE(text, ''::text) || ' '::text) || COALESCE(keywords, ''::text))), 'C'::"char"))
  STORED;

-- ===========================================================================
-- Dense vector index
-- ===========================================================================

-- Cosine distance over the 1024-d embedding: the semantic arm. hnsw, not ivfflat,
-- and cosine, not L2, because the stored vectors are text embeddings normalized
-- for cosine ranking.
CREATE INDEX "Chunk_embedding_hnsw" ON "Chunk" USING hnsw ("embedding" vector_cosine_ops);

-- ===========================================================================
-- Lexical index
-- ===========================================================================

-- The keyword arm over the generated vector.
CREATE INDEX "Chunk_tsv_gin" ON "Chunk" USING gin ("tsv");

-- ===========================================================================
-- Trigram indexes
-- ===========================================================================

-- Fuzzy-match arms for identifiers (serials, SKUs, IPs, room codes) that
-- tokenised search handles badly. The measurement behind the pair: typo lookups
-- that missed the title were found through the body, so "text" carries the
-- primary trigram index and "sourceTitle" a second one for titled lookups.
CREATE INDEX "Chunk_text_trgm" ON "Chunk" USING gin ("text" gin_trgm_ops);

CREATE INDEX "Chunk_sourceTitle_trgm" ON "Chunk" USING gin ("sourceTitle" gin_trgm_ops);
