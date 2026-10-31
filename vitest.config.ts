import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // Provisions the isolated `<dbname>_test` database once per run (create +
    // migrate deploy + demo seed); setup-env.ts then redirects each worker's
    // DATABASE_URL at it. Dev DB and `pnpm test:e2e` are untouched.
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup-env.ts", "./test/setup-tx-timeout.ts"],
    // docs/**/*.test.ts carries the doc-link guard, which keeps its fixture next to the
    // documents it checks.
    include: ["app/**/*.test.ts", "test/**/*.test.ts", "docs/**/*.test.ts"],
    // DB-backed guard tests share one Postgres; don't run files in parallel.
    fileParallelism: false,
    // Cases that spawn Git Bash (ops scripts, seed and transfer drills) take 2-3 s alone on
    // Windows and exceed vitest's 5 s default when the machine is busy or a scanner inspects
    // each spawn. The per-spawn guards in those tests stay below this bound.
    testTimeout: 60_000,
  },
});
