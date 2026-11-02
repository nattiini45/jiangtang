import { afterAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

/**
 * CI GUARD. `20261023000000_extensions` installs pgvector and
 * pg_trgm; this asserts the database the suite runs against actually HAS them,
 * and that they work rather than merely appearing in the catalog.
 *
 * Why a catalog lookup is not enough on its own: `CREATE EXTENSION` succeeding
 * and `pg_extension` carrying a row do not prove the C library loads. So the
 * functional tests below build a real HNSW index over a `vector(1024)` column
 * and a real GIN trigram index, and both run inside a transaction that is
 * always rolled back.
 *
 * The version assertions are FLOORS, not pinned values: a patch bump of the
 * pgvector image must not fail this suite, but a drop below the floor removes
 * a capability the application depends on (HNSW at 1024-d) and must.
 */

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

afterAll(async () => {
  await pool.end();
});

/** Run fn in a transaction that is ALWAYS rolled back (no residue). */
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

/** "0.8.7" -> [0, 8, 7], "1.6" -> [1, 6], for a numeric floor comparison. */
function versionTuple(v: string): number[] {
  return v.split(".").map((n) => Number.parseInt(n, 10));
}

function atLeast(actual: string, floor: string): boolean {
  const a = versionTuple(actual);
  const f = versionTuple(floor);
  for (let i = 0; i < Math.max(a.length, f.length); i++) {
    const x = a[i] ?? 0;
    const y = f[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

describe("search extensions", () => {
  it("installs vector and pg_trgm", async () => {
    const { rows } = await pool.query<{ extname: string; extversion: string }>(
      `SELECT extname, extversion FROM pg_extension
        WHERE extname IN ('vector', 'pg_trgm') ORDER BY extname`,
    );

    // Two rows, named exactly. A non-empty check alone would pass on one.
    expect(rows.map((r) => r.extname)).toEqual(["pg_trgm", "vector"]);
  });

  it("installs a vector new enough for HNSW at the 1024-d width the search index needs", async () => {
    const { rows } = await pool.query<{ extversion: string }>(
      `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
    );
    expect(rows).toHaveLength(1);
    expect(atLeast(rows[0].extversion, "0.8.0")).toBe(true);
  });

  it("installs a pg_trgm new enough for gin_trgm_ops", async () => {
    const { rows } = await pool.query<{ extversion: string }>(
      `SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    expect(rows).toHaveLength(1);
    expect(atLeast(rows[0].extversion, "1.6")).toBe(true);
  });

  it("builds and answers an HNSW index over vector(1024)", async () => {
    const got = await inRolledBackTx(async (c) => {
      await c.query(`CREATE TEMP TABLE probe (id serial primary key, emb vector(1024))`);
      // Two unit vectors a whole dimension apart; cosine distance from q to itself is 0.
      const unit = (i: number) => {
        const v = new Array<number>(1024).fill(0);
        v[i] = 1;
        return `[${v.join(",")}]`;
      };
      await c.query(`INSERT INTO probe (id, emb) VALUES (1, $1::vector), (2, $2::vector)`, [
        unit(0),
        unit(1),
      ]);
      await c.query(`CREATE INDEX probe_hnsw ON probe USING hnsw (emb vector_cosine_ops)`);
      const r = await c.query<{ id: number; dist: number }>(
        `SELECT id, emb <=> $1::vector AS dist FROM probe ORDER BY emb <=> $1::vector LIMIT 1`,
        [unit(0)],
      );
      return r.rows[0];
    });

    expect(got).toBeDefined();
    expect(got.id).toBe(1);
    expect(got.dist).toBeCloseTo(0, 6);
  });

  it("matches serial-number text through a GIN trigram index", async () => {
    const got = await inRolledBackTx(async (c) => {
      await c.query(`CREATE TEMP TABLE probe (id serial primary key, code text)`);
      await c.query(`INSERT INTO probe (code) VALUES ('D.11.23'), ('D.03.35b'), ('RM 0007')`);
      await c.query(`CREATE INDEX probe_trgm ON probe USING gin (code gin_trgm_ops)`);
      const r = await c.query<{ code: string; score: number }>(
        `SELECT code, similarity(code, $1) AS score FROM probe
          WHERE code % $1 ORDER BY score DESC LIMIT 1`,
        ["D.11.23"],
      );
      return r.rows[0];
    });

    expect(got?.code).toBe("D.11.23");
    expect(got?.score).toBeCloseTo(1, 6);
  });
});
