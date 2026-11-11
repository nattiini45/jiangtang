import { defineConfig, devices } from "@playwright/test";
import { validateTestDatabaseUrl } from "./test/test-db";

/**
 * Playwright end-to-end suite: a real server on a loopback port, backed by its
 * own `*_e2e` database. One worker, because every spec shares that database.
 * `pnpm test:e2e` is separate from `pnpm test`; CI runs it as the E2E browser
 * gate on `main` and pull requests.
 *
 * DATABASE_URL_E2E is validated at config evaluation, before webServer starts.
 * E2E_BASE_URL must be a loopback origin. A running server is never reused.
 */

// Validate DATABASE_URL_E2E at config evaluation time (before webServer)
const e2eDbUrl = process.env.DATABASE_URL_E2E;
if (!e2eDbUrl) {
  throw new Error(
    "DATABASE_URL_E2E must be set before Playwright starts. " +
      "This ensures E2E tests use an isolated database.",
  );
}

// Validate the E2E database URL with required _e2e suffix
validateTestDatabaseUrl(e2eDbUrl, { requiredSuffix: "_e2e" });

// Set DATABASE_URL for the webServer child process BEFORE it starts
process.env.DATABASE_URL = e2eDbUrl;

const E2E_BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3100";

// The default gate only runs specs that assert. The @screens suite
// (e2e/screens.spec.ts) takes about 42 full-page screenshots and asserts little,
// so it is excluded unless the invocation names it (`pnpm test:e2e --grep @screens`).
// Naming @screens on the command line lifts the exclusion for that run only. A
// custom environment switch is not used, because the environment of the run is
// kept fixed.
const wantsScreens = process.argv.some((arg) => arg.includes("@screens"));

// Validate E2E_BASE_URL is loopback HTTP only
let e2eUrl: URL;
try {
  e2eUrl = new URL(E2E_BASE_URL);
  if (
    e2eUrl.protocol !== "http:" ||
    (e2eUrl.hostname !== "localhost" && e2eUrl.hostname !== "127.0.0.1")
  ) {
    throw new Error(`E2E_BASE_URL must be loopback HTTP, got ${E2E_BASE_URL}`);
  }
} catch (error) {
  throw new Error(`Invalid E2E_BASE_URL: ${E2E_BASE_URL}`, { cause: error });
}

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  // Exclude the @screens screenshot suite from the default gate; lifted
  // when the invocation itself names @screens (see `wantsScreens` above).
  grepInvert: wantsScreens ? undefined : /@screens/,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: E2E_BASE_URL,
    // Chromium sends en-US otherwise, which would flip the UI to English.
    locale: "de-DE",
    storageState: "e2e/.auth/admin.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Not `pnpm dev`, which runs `cross-env NODE_ENV=development tsx watch
    // ./server.ts`. `tsx watch` supervises a child process, and under Playwright's
    // shell-and-pipes launch that child did not reach httpServer.listen, so the
    // run failed with a webServer timeout. This command is the same server
    // without the watcher.
    command: "pnpm exec tsx ./server.ts",
    url: `${E2E_BASE_URL}/login`,
    reuseExistingServer: false,
    // A timing bound, not a retry. On a loaded machine a cold start (empty
    // compile and dependency caches) took about 85 seconds before the first boot
    // log; the application's own boot takes about 1.2 seconds. The bound leaves
    // margin for a slow start, while a server that never binds still fails.
    timeout: 240_000,
    // Keep the server's output: a webServer timeout is otherwise undiagnosable.
    stdout: "pipe",
    stderr: "pipe",
    // Playwright merges the parent process environment into the server's, so a
    // developer's exported variables would reach the run unless they are set here.
    // The server also loads `.env` for names the environment does not set, and it
    // never overrides a name that is already set. The blanks below therefore switch
    // off bootstrap configuration and outbound endpoints, credentials and models; the
    // database, base URL and locale are pinned as well.
    env: {
      NODE_ENV: "development",
      PORT: new URL(E2E_BASE_URL).port || "3100",
      BETTER_AUTH_URL: E2E_BASE_URL,
      DATABASE_URL: e2eDbUrl,
      DEFAULT_LOCALE: "de",
      ADMIN_EMAIL: "",
      ADMIN_PASSWORD: "",
      ADMIN_INITIALS: "",
      EMBEDDING_BASE_URL: "",
      EMBEDDING_MODEL: "",
      EMBEDDING_API_KEY: "",
      RERANK_BASE_URL: "",
      RERANK_MODEL: "",
      RERANK_API_KEY: "",
      GENERATION_BASE_URL: "",
      GENERATION_MODEL: "",
      GENERATION_API_KEY: "",
      CALDAV_URL: "",
      CALDAV_USERNAME: "",
      CALDAV_PASSWORD: "",
      GLITCHTIP_DSN: "",
      ALERT_WEBHOOK: "",
      ICAL_FEED_TOKEN: "",
    },
  },
});
