import type { TestProject } from "vitest/node";
import { ensureTestDatabase, provisionTestDatabase, testDatabaseUrl } from "./test-db";

/**
 * Vitest global setup: provision the isolated test database once per run. It
 * creates `<dbname>_test` if missing, applies `prisma migrate deploy`, then runs
 * the idempotent demo seed into it. The validated URL goes to the workers through
 * Vitest's provide/inject mechanism, so it is derived only once.
 *
 * This hook does not read a `.env` file. The test environment is whatever the
 * process was started with, so a file in the working directory cannot add
 * variables to the run (for example proxy or provider credentials). No fallback
 * is derived here: when neither `DATABASE_URL_TEST` nor `DATABASE_URL` is set,
 * `testDatabaseUrl()` throws before any connection, CREATE DATABASE, migration or
 * seed is attempted.
 */
export default async function setup({ provide }: TestProject): Promise<void> {
  const url = testDatabaseUrl();
  // Provide the validated URL to all workers via Vitest's inject mechanism.
  // This ensures exactly-once distribution with no re-derivation or double suffix.
  provide("testDatabaseUrl", url);
  await ensureTestDatabase(url);
  provisionTestDatabase(url);
}
