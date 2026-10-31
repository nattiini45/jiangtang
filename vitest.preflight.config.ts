import { defineConfig } from "vitest/config";

/**
 * No-database preflight for the pure configuration/safety guards.
 *
 * Deliberately does NOT import `vitest.config.ts` and does NOT declare a
 * `globalSetup`, so collecting or running this config can never provision a
 * database: there is no path from here to `ensureTestDatabase` or
 * `provisionTestDatabase`.
 *
 * `include` is the exact preflight list. `test/storage-config.test.ts` and
 * `test/ops-config.test.ts` are listed here; a missing entry is permitted
 * "only while its guard test is still being added", and Vitest 3.2.6 tolerates
 * an explicit include pattern that matches nothing as long as at least one
 * listed file exists.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/test-db.test.ts", "test/storage-config.test.ts", "test/ops-config.test.ts"],
    fileParallelism: false,
  },
});
