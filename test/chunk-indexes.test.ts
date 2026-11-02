import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

/**
 * `Chunk` + `SearchIndexJob` exist with the four folded indexes and the
 * generated `tsv` column the schema cannot express.
 *
 * Everything is read from the live database inside rolled-back transactions —
 * the migration is applied history on dev, and pg_catalog is the contract a
 * `migrate diff` residual would have to satisfy anyway.
 */

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

async function inRolledBackTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

let seq = 0;
const uid = (p: string) => `chunk_${p}_${Date.now()}_${seq++}`;

async function insertChunk(c: PoolClient, over: { text?: string; keywords?: string } = {}) {
  const id = uid("chunk");
  await c.query(
    `INSERT INTO "Chunk"("id","sourceType","sourceId","sourceTitle","ordinal","headingPath","text","keywords","tokenCount","contentHash","sourceUpdatedAt","updatedAt")
     VALUES($1,'NOTE',$2,'Titel',0,'{}',$3,$4,10,'h',now(),now())`,
    [id, uid("src"), over.text ?? "Ein Beamer im Hörsaal", over.keywords ?? ""],
  );
  return id;
}

describe("chunk indexes", () => {
  it("all four folded indexes exist with the right access method / opclass", async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'Chunk'`,
    );
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));

    expect(byName.get("Chunk_embedding_hnsw")).toMatch(/USING hnsw/);
    expect(byName.get("Chunk_embedding_hnsw")).toMatch(/vector_cosine_ops/);
    expect(byName.get("Chunk_tsv_gin")).toMatch(/USING gin \(tsv\)/);
    expect(byName.get("Chunk_text_trgm")).toMatch(/gin_trgm_ops/);
    expect(byName.get("Chunk_sourceTitle_trgm")).toMatch(/gin_trgm_ops/);
  });

  it("embedding is exactly vector(1024) — the width is fixed for the life of the DB", async () => {
    const { rows } = await pool.query<{ formatted: string }>(
      `SELECT format_type(atttypid, atttypmod) AS formatted
       FROM pg_attribute WHERE attrelid = '"Chunk"'::regclass AND attname = 'embedding'`,
    );
    expect(rows[0]?.formatted).toBe("vector(1024)");
  });

  it("tsv is a STORED generated column (attgenerated = 's')", async () => {
    const { rows } = await pool.query<{ attgenerated: string }>(
      `SELECT attgenerated FROM pg_attribute
       WHERE attrelid = '"Chunk"'::regclass AND attname = 'tsv'`,
    );
    expect(rows[0]?.attgenerated).toBe("s");
  });

  it("inserting a chunk populates tsv — title at weight A, text searchable", async () => {
    await inRolledBackTx(async (c) => {
      const id = await insertChunk(c, { text: "Der Projektor ist defekt", keywords: "beamer" });
      const { rows } = await c.query<{ tsv: string }>(
        `SELECT tsv::text AS tsv FROM "Chunk" WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.tsv).toContain("beamer"); // 'simple' keeps the keyword whole
      expect(rows[0]?.tsv).toContain("titel"); // german stems "Titel"
      const found = await c.query(
        `SELECT 1 FROM "Chunk" WHERE id = $1 AND tsv @@ to_tsquery('german', 'projektor')`,
        [id],
      );
      expect(found.rowCount).toBe(1);
    });
  });

  it("a 384-wide vector is rejected by the column", async () => {
    await inRolledBackTx(async (c) => {
      const id = await insertChunk(c);
      const narrow = `[${new Array(384).fill(0).join(",")}]`;
      // Savepoint: the rejected UPDATE aborts the tx — the positive control
      // still needs to run in the same rolled-back transaction.
      await c.query("SAVEPOINT narrow");
      await expect(
        c.query(`UPDATE "Chunk" SET embedding = $1::vector WHERE id = $2`, [narrow, id]),
      ).rejects.toThrow(/1024|dimensions/i);
      await c.query("ROLLBACK TO SAVEPOINT narrow");
      // positive control: the right width is accepted
      const right = `[${new Array(1024).fill(0).join(",")}]`;
      await c.query(`UPDATE "Chunk" SET embedding = $1::vector WHERE id = $2`, [right, id]);
    });
  });

  it("SearchIndexJob carries the retry ledger contract", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'SearchIndexJob'`,
    );
    const cols = new Set(rows.map((r) => r.column_name));
    for (const col of ["sourceType", "sourceId", "op", "attempts", "lastError", "nextAttemptAt"]) {
      expect(cols, `SearchIndexJob.${col}`).toContain(col);
    }
  });
});
