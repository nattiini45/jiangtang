-- Functional baseline, file 1 of 7: required PostgreSQL extensions.
--
-- Responsibility: install every non-default extension the later baseline files
-- depend on, before any column, index or exclusion constraint that needs it.
--   btree_gist  - GiST operator classes for the "=" half of the booking
--                 exclusion constraints (20261023000200_booking_constraints).
--   vector      - the pgvector type/opclasses used by Chunk.embedding,
--                 vector(1024), and its cosine HNSW index
--                 (20261023000100_core_schema, 20261023000400_search_indexes).
--   pg_trgm     - trigram operator classes used by the search GIN indexes
--                 (20261023000400_search_indexes).
--
-- plpgsql is installed in pg_catalog by initdb in every PostgreSQL cluster and
-- is not created here. Nothing else is created in this file: no schema, no
-- table, no function, no data.
--
-- The installed versions are supplied by the PostgreSQL image, exactly as in
-- the reference installation; this file does not pin a version, so a fresh
-- install resolves the same packaged builds the reference database ran with.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
