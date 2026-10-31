import type { TestProject } from "vitest/node";
import { ensureTestDatabase, provisionTestDatabase, testDatabaseUrl } from "./test-db";

/**
 * Vitest global setup: provision the isolated test database once per run —
 * create `<dbname>_test` if missing, apply `prisma migrate deploy`, then run
 * the idempotent demo seed into it. The validated URL is distributed to workers
 * via Vitest 3's provide/inject mechanism (no re-derivation, no double suffix).
 *
 * This hook deliberately does NOT read an ambient `.env`. The
 * Node env-file loader call that used to open this function — wrapped in a
 * try/catch that swallowed its failure — has been DELETED. The test environment
 * must be explicitly constructed rather than inherited from whatever `.env`
 * happens to sit in the cwd. The caller owns that construction: it passes a
 * fixed set of names and refuses to start if a `.env` file exists, so an
 * env-file read here could only ever add names the caller omits on purpose
 * (proxy / provider credentials). The removed API is intentionally not named in
 * this comment, so
 * that the structural grep for it over this directory stays empty and
 * remains a machine-checkable proof that no such call survives here. Do not
 * re-add the call, and do not name it in prose.
 *
 * The environment must therefore be SUPPLIED to the test run; the caller
 * supplies it. No fallback is derived here: when neither `DATABASE_URL_TEST` nor
 * `DATABASE_URL` is present, `testDatabaseUrl()` fails closed with "DATABASE_URL
 * must be set for the DB-backed guard tests." — before any connection, CREATE
 * DATABASE, migration or seed is attempted. Nothing else in this file depended on
 * the removed try/catch.
 */
export default async function setup({ provide }: TestProject): Promise<void> {
  const url = testDatabaseUrl();
  // Provide the validated URL to all workers via Vitest's inject mechanism.
  // This ensures exactly-once distribution with no re-derivation or double suffix.
  provide("testDatabaseUrl", url);
  await ensureTestDatabase(url);
  provisionTestDatabase(url);
}
