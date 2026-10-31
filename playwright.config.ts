import { defineConfig, devices } from "@playwright/test";
import { validateTestDatabaseUrl } from "./test/test-db";

/**
 * Playwright — e2e against the real dev server + dev DB. One worker:
 * every spec shares the same database. `pnpm test:e2e` only — separate from
 * `pnpm test`, and run in CI by the E2E browser gate on `main` and PRs.
 *
 * Require DATABASE_URL_E2E and validate at CONFIG EVALUATION (before
 * webServer starts). Use E2E_BASE_URL for loopback-only origins. Never reuse
 * an existing server — fail if port is occupied.
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

// The default gate (`pnpm test:e2e`) must only run tests that actually
// assert. The
// `@screens` suite (e2e/screens.spec.ts) is review material — ~42 full-page
// screenshots that historically made no assertions and passed even against a
// 404 — so it is excluded from the default gate via grepInvert.
//
// The exclusion stays discoverable and reversible from the CLI: naming
// `@screens` in any argument (the documented form is
// `pnpm test:e2e --grep @screens`) lifts grepInvert for that invocation, so
// the screenshot suite remains runnable without editing this file. A custom
// env-var switch is NOT used because the run's environment is fixed and must
// not be widened.
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
    // NOT `pnpm dev`. That script is
    //   cross-env NODE_ENV=development tsx watch ./server.ts
    // and `tsx watch` is a *supervisor*: under Playwright's own launch
    // (shell + piped stdio on Windows) it never reaches httpServer.listen, so
    // the run dies with "Timed out waiting 120000ms from config.webServer".
    // This is the non-watch equivalent of the same script, measured on this
    // host against `${E2E_BASE_URL}/login`:
    //   HTTP 200 in 13.1s / 21.4s (generated caches cleared) / 25.2s.
    // NODE_ENV is pinned explicitly in `env` below rather than through
    // cross-env, so development semantics never depend on ambient environment
    // (the environment is constructed, not inherited).
    command: "pnpm exec tsx ./server.ts",
    url: `${E2E_BASE_URL}/login`,
    reuseExistingServer: false,
    // 120s -> 240s, a timing bound, not a retry. Measured on this host on
    // 2026-10-18: a legitimate cold start consumed ~85s from
    // command start to the FIRST server boot log (compile/startup dominates;
    // app-internal boot itself is only ~1.2s) on a machine concurrently
    // running several heavy background processes. One run overran the old
    // 120s bound ("Timed out waiting 120000ms from config.webServer",
    // 2026-10-18, one-off, never reproduced; no code exception observed).
    // 240s is ~2.8x the measured cold start: margin for a slow-but-legitimate
    // start, while a genuinely hung server that never binds still fails the
    // run — and the piped stdout/stderr below now show where it stopped.
    timeout: 240_000,
    // Capture webServer stdout/stderr. A webServer startup timeout currently
    // yields NO boot evidence — the 2026-10-18 one-off "Timed out waiting
    // 120000ms from config.webServer" could not be diagnosed for that reason.
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "development",
      PORT: new URL(E2E_BASE_URL).port || "3100",
      BETTER_AUTH_URL: E2E_BASE_URL,
      DATABASE_URL: e2eDbUrl,
      DEFAULT_LOCALE: "de",
    },
  },
});
