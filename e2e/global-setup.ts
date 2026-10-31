import { mkdirSync, writeFileSync } from "node:fs";
import { chromium, type Frame, type FullConfig, type Page } from "@playwright/test";

/**
 * Logs the bootstrap admin in once (credentials from ADMIN_EMAIL /
 * ADMIN_PASSWORD — never printed, never hard-coded) and saves the session for
 * every spec via `storageState`. Also writes this run's id for the shared
 * `e2e-<runId>-` fixture prefix.
 *
 * Use the configured baseURL from Playwright config, not hardcoded port.
 *
 * This harness deliberately does NOT call `process.loadEnvFile()`. The test
 * environment must be *explicitly constructed*, not inherited from whatever
 * `.env` happens to sit in the cwd — an ambient file read would pull private
 * file state into the harness silently. Every value read below comes from the
 * process environment supplied to the run (`ADMIN_EMAIL`, `ADMIN_PASSWORD`,
 * `E2E_BASE_URL`); a missing one is a hard error rather than a fallback to a
 * file.
 *
 * After login, this setup also primes Vite's dependency-optimiser cache
 * on a cold `node_modules/.vite`. The webServer readiness probe only fetches
 * `/login`, which never imports `@dnd-kit` (used by `app/components/board/*`),
 * so on a cold cache the FIRST `/board` visit discovers new deps mid-run,
 * Vite re-optimises and force-reloads the page, and the board test fails with
 * "Invalid hook call … more than one copy of React" /
 * "Cannot read properties of null (reading 'useContext')". `vite.config.ts`
 * (with `optimizeDeps.include`) is deliberately unchanged by this release, so
 * the cache is warmed here instead: the setup signs in THROUGH the reload storm
 * (waiting for the optimiser to settle before each interaction) and walks the
 * lazy-discovery routes before handing off to the tests. This removes the race
 * rather than hiding it — `webServer.timeout` is NOT widened.
 */

/**
 * Route(s) that pull dependencies Vite cannot see from `/login` alone, so a
 * cold cache discovers them lazily and re-optimises MID-RUN. `/board` imports
 * `@dnd-kit/*` (app/components/board/board.tsx:13-14, board-column.tsx:1-2,
 * task-card.tsx:2, drop.ts:2); none of those packages are reachable from the
 * login shell, so the first `/board` visit is where Vite re-bundles and
 * force-reloads — the exact trigger for the "Invalid hook call … more than
 * one copy of React" board crash.
 *
 * Scope is `/board` plus the two routes that pull their own lazy deps. The
 * evidence showed the smoke surfaces share the `/login` scan, but cold-cache
 * runs on this host proved two a11y surfaces still re-optimise mid-run: the
 * project detail route statically
 * imports `ProjectBurndown` (`recharts`), and the note editor imports
 * `MarkdownPreview` (`react-markdown`, `remark-gfm`). Neither package is
 * reachable from `/login` or `/board`, so Vite discovers it on the first
 * gantt/editor visit, reloads the page, and the scan lands on the Application
 * Error boundary. The seeded demo rows are used because the a11y spec creates
 * its own project/note in `test.beforeAll`, after this setup has finished.
 * Each entry is `[path, expected h1]`; the h1 is the route's own heading
 * oracle (the same component markers screens.spec.ts asserts), used here to
 * prove the route actually settled before handoff.
 */
const PRIME_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["/board", "Board"],
  ["/projects/lager-logistik?view=gantt", "Lager & Logistik"],
  ["/notes/seed_note_06", "Standorte und Zuständigkeiten"],
];

/**
 * Wait until Vite's dependency optimiser stops force-reloading the page.
 *
 * On a cold `node_modules/.vite`, each newly discovered dep makes Vite rewrite
 * the optimised bundle and issue a full-page reload ("optimized dependencies
 * changed. reloading"). Interacting with the DOM during that storm is what
 * makes cold login flaky: the submit button is detached mid-click and the form
 * POST is dropped. This watches main-frame navigations and returns only after a
 * quiet window with none — i.e. once the optimiser has converged. Bounded by
 * `maxMs` so a genuinely broken page still surfaces rather than hanging.
 */
async function waitForViteSettle(
  page: Page,
  { quietMs = 2_000, maxMs = 90_000 }: { quietMs?: number; maxMs?: number } = {},
): Promise<void> {
  let lastNav = Date.now();
  const main = page.mainFrame();
  const onNav = (frame: Frame) => {
    // Any main-frame navigation (including a Vite full reload) resets the clock.
    if (frame === main) lastNav = Date.now();
  };
  page.on("framenavigated", onNav);
  const start = Date.now();
  try {
    while (Date.now() - start < maxMs) {
      await page.waitForTimeout(200);
      if (Date.now() - lastNav >= quietMs) return;
    }
  } finally {
    page.off("framenavigated", onNav);
  }
}

/**
 * Navigate to `path` and let the optimiser settle. The goto is attempted twice
 * because a Vite reload can abort an in-flight navigation (surfaces as a goto
 * rejection); the second attempt runs against the just-warmed cache.
 */
async function gotoSettled(page: Page, path: string): Promise<void> {
  await page
    .goto(path, { waitUntil: "load", timeout: 60_000 })
    .catch(() => page.goto(path, { waitUntil: "load", timeout: 60_000 }));
  await waitForViteSettle(page);
}

export default async function globalSetup(config: FullConfig) {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "e2e global setup needs ADMIN_EMAIL and ADMIN_PASSWORD in the process " +
        "environment (supplied by the run). This harness does not read" +
        "a .env file — see.",
    );
  }

  mkdirSync("e2e/.auth", { recursive: true });
  writeFileSync("e2e/.run-id", `e2e-${Date.now().toString(36)}-`);

  const baseURL =
    (config.projects[0]?.use.baseURL as string | undefined) ??
    process.env.E2E_BASE_URL ??
    "http://localhost:3100";
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL, locale: "de-DE" });

    // Cold-cache determinism: sign in, SURVIVING Vite's dependency
    // optimiser reloads. The webServer readiness probe only fetches `/login`,
    // so on a cold `node_modules/.vite` Vite discovers the rest of the graph
    // lazily while the browser navigates and force-reloads the page on each new
    // dep ("optimized dependencies changed. reloading"). Measured on this host:
    // a cold login navigates `/login → /login → /login → /` — the reloads are
    // real. When one lands DURING the login form POST it drops the POST and
    // leaves a fresh, empty `/login`, so a single submit-and-wait hangs there
    // forever (reproduced with the 15s URL bound, and again with a 60s h1
    // bound). A bounded resubmit loop fixes this at the root:
    // each pass warms more of the cache, so the reloads converge and the POST
    // eventually lands on a settled server.
    //
    // This is a SETUP navigation retry against a dev-server cache race. It is
    // NOT a Playwright test retry and it softens nothing: `retries` stays 0 in
    // playwright.config.ts, no test timeout changes, and the success oracle is
    // the dashboard's route-specific <h1> "Übersicht" (the login form's
    // `next="/"` target, app/routes/_desktop._index/route.tsx:150) — the URL
    // alone changing is not enough. If login cannot reach the dashboard the run fails
    // loudly here rather than proceeding with a bad session.
    const dashboard = page.getByRole("heading", {
      level: 1,
      name: "Übersicht",
      exact: true,
    });
    const MAX_LOGIN_ATTEMPTS = 6;
    let signedIn = false;
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS && !signedIn; attempt++) {
      // (Re)land on the login form and let the optimiser settle BEFORE touching
      // it — clicking a submit button that Vite is actively detaching/reloading
      // is what made cold login flaky. If a previous attempt already set the
      // session cookie, `/login`'s loader redirects an authenticated user
      // straight to the dashboard and there is no form to fill.
      await gotoSettled(page, "/login");
      try {
        const emailInput = page.locator('input[name="email"]');
        if (await emailInput.count()) {
          await emailInput.fill(email);
          await page.locator('input[name="password"]').fill(password);
          // Scoped to the credentials form: the language switcher also renders
          // submit buttons on this page.
          await page
            .locator('form:has(input[name="email"]) button[type="submit"]')
            .click({ timeout: 15_000 });
        }
      } catch {
        // A late reload detached the form mid-interaction: the settle wait on
        // the next attempt runs against a warmer cache, so just retry.
        continue;
      }
      // Success == the dashboard <h1> is visible. This locator wait is
      // navigation-safe, so it also rides out a Vite reload OF `/` while the
      // dashboard's own deps are discovered.
      signedIn = await dashboard.waitFor({ state: "visible", timeout: 30_000 }).then(
        () => true,
        () => false,
      );
    }
    if (!signedIn) {
      throw new Error(
        `e2e global setup: login did not reach the dashboard <h1> "Übersicht" ` +
          `after ${MAX_LOGIN_ATTEMPTS} attempts (cold-cache Vite optimiser ` +
          `reloads kept interrupting the POST, or the session/credentials are ` +
          `broken). Last URL: ${page.url()}`,
      );
    }
    await page.context().storageState({ path: "e2e/.auth/admin.json" });

    // Prime Vite's dependency-optimiser cache on the authenticated
    // session before any test runs, so the lazily-discovered deps (notably
    // `@dnd-kit` on the first `/board` visit) are optimised HERE rather than
    // mid-test. Unlike the login POST, these are GET navigations: a Vite
    // optimiser reload just re-GETs the same URL, and the <h1> wait below is
    // navigation-safe, so it rides through the reload until the route settles.
    // No explicit settle wait is needed (that would add a fixed quiet window to
    // every route even when warm); the bounded re-goto covers a reload that
    // aborts the navigation itself. A route that never renders its <h1> once the
    // cache is warm (e.g. the duplicate-React crash this repair exists for)
    // fails the run here, loudly, instead of flaking individual tests later.
    for (const [path, heading] of PRIME_ROUTES) {
      const marker = page.getByRole("heading", { level: 1, name: heading, exact: true });
      let settled = false;
      for (let attempt = 1; attempt <= 4 && !settled; attempt++) {
        await page
          .goto(path, { waitUntil: "load", timeout: 60_000 })
          .catch(() => page.goto(path, { waitUntil: "load", timeout: 60_000 }));
        settled = await marker.waitFor({ state: "visible", timeout: 30_000 }).then(
          () => true,
          () => false,
        );
      }
      if (!settled) {
        throw new Error(
          `e2e global setup: cache-priming route ${path} never rendered its ` +
            `<h1> "${heading}" on a cold cache (last URL ${page.url()}). This ` +
            `is the mid-run Vite dep-optimiser race this priming repairs; the run is ` +
            `stopped here rather than allowed to flake the tests.`,
        );
      }
    }
  } finally {
    await browser.close();
  }
}
