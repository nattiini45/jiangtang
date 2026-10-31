import { test, expect } from "@playwright/test";

/**
 * Scope the `theme` cookie to the SAME origin the fixture navigates against,
 * derived from Playwright's own `baseURL` fixture rather than a fixed port.
 *
 * Measured impact of the old literal (Chromium, `context.cookies()`): it was
 * stored as `Domain=localhost, Path=/`, and cookies are NOT port-isolated
 * (RFC 6265 8.5), so it was still sent to `http://localhost:3100`. The old code
 * therefore did not break the default configuration. It DID break one this repo
 * explicitly allows: `playwright.config.ts` accepts `127.0.0.1` as the loopback
 * host, and a `Domain=localhost` cookie is not sent to
 * `http://127.0.0.1:3100` — so under `E2E_BASE_URL=http://127.0.0.1:3100` every
 * "dark" screenshot here would silently have been the light theme. Deriving the
 * origin from the fixture removes that whole class of drift.
 *
 * Duplicated verbatim in `a11y.spec.ts` on purpose: a shared helper module
 * would add another implementation file for no gain.
 */
function themeCookieOrigin(baseURL: string | undefined): string {
  if (!baseURL) {
    throw new Error(
      "the theme cookie needs the fixture baseURL; playwright.config.ts must set use.baseURL",
    );
  }
  const url = new URL(baseURL);
  if (url.protocol !== "http:") {
    throw new Error(`the theme cookie origin must be loopback HTTP, got ${url.origin}`);
  }
  return url.origin;
}

/**
 * Screens-only lazy deps: navigate to `path` and require its route-specific
 * <h1> `marker` to be visible, surviving a first-visit Vite dependency
 * re-optimisation.
 *
 * Why this is not a plain `goto` + `toBeVisible`: several screens routes pull
 * deps the `/login` readiness scan never sees and that the smoke gate's
 * `/board` prime does not cover — `note-editor` imports `react-markdown` +
 * `remark-gfm` (app/components/notes/markdown-preview.tsx:1-2), and the
 * `project-gantt` view imports its own chart modules. On a cold/partially-warm
 * cache the FIRST visit to such a route makes Vite re-bundle and force-reload
 * mid-render, which crashes React ("more than one copy of React") into the
 * route ErrorBoundary — the captured page is literally `heading "Application
 * Error"`. That is exactly the
 * garbage baseline the marker exists to catch, and the second visit (warm
 * cache) renders fine.
 *
 * So: assert the marker with a bounded re-goto. The first pass warms the
 * optimiser; if the marker is missing (crash/reload), re-goto against the now
 * warm cache and assert again. The marker is NEVER softened — a route that
 * cannot render its own <h1> once warm is a real failure and is thrown. This is
 * a navigation retry against the documented dev-server cache race, not a
 * Playwright test retry (config `retries` stays 0) and not a weaker oracle.
 */
async function gotoAndAssertMarker(
  page: import("@playwright/test").Page,
  path: string,
  marker: string,
): Promise<void> {
  const heading = page.getByRole("heading", { level: 1, name: marker, exact: true });
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page
      .goto(path, { waitUntil: "load", timeout: 60_000 })
      .catch(() => page.goto(path, { waitUntil: "load", timeout: 60_000 }));
    const ok = await heading.waitFor({ state: "visible", timeout: 15_000 }).then(
      () => true,
      () => false,
    );
    if (ok) return;
    // Marker absent: a first-visit re-optimisation crashed/reloaded the route.
    // The cache is now warm, so the next attempt renders it. Loop re-goes.
  }
  throw new Error(
    `screens: ${path} never rendered its route marker <h1> "${marker}" after 4 ` +
      `cold-cache attempts (last URL ${page.url()}). Either the Vite dep ` +
      `optimiser race never settled or the marker no longer matches the route.`,
  );
}

/**
 * Theme screenshots — opt-in (`pnpm test:e2e --grep @screens`; the
 * default gate excludes `@screens` via `grepInvert` in playwright.config.ts):
 * full-page PNGs of the key routes in light and dark, written to
 * `test-results/screens/<route>-<theme>.png` (gitignored). Review material,
 * but NOT assertion-free: each capture first asserts its route marker
 * so a 404, a lost session (login shell) or a wrong page cannot silently
 * produce a blank/garbage baseline that looks valid.
 *
 * The main surfaces, plus task detail, project gantt/burndown,
 * the note editor (seed_note_06 carries headings + table + checklist), a
 * "Mischpult" search, the ask box in its results-only state, /admin/index,
 * and the mobile board/search/capture routes.
 *
 * Markers: the third tuple column is the <h1> text the route component
 * renders (cited per row). task-detail / note-editor / project markers are the
 * SEEDED titles this suite already depends on (seed_task_hs_01, seed_note_06,
 * hoersaaltechnik-ws2425 in scripts/seed/data.ts); the E2E database is seeded
 * per run before this suite can run at all.
 */
const ROUTES = [
  // [name, path, h1 marker, component/seed source]
  ["dashboard", "/", "Übersicht", "_desktop._index/route.tsx:150"],
  ["tasks", "/tasks", "Aufgaben", "_desktop.tasks._index/route.tsx:120"],
  [
    "task-detail",
    "/tasks/seed_task_hs_01",
    "Beamer-Vergleich 2025 durchführen",
    "_desktop.tasks.$id/route.tsx:222 + seed data.ts:418",
  ],
  ["board", "/board", "Board", "_desktop.board/route.tsx:157"],
  ["projects", "/projects", "Projekte", "_desktop.projects._index/route.tsx:63"],
  [
    "project-gantt",
    "/projects/hoersaaltechnik-ws2425?view=gantt",
    "Raumtechnik Demo",
    "_desktop.projects.$slug/route.tsx:162 + seed data.ts:326",
  ],
  [
    "project-burndown",
    "/projects/hoersaaltechnik-ws2425?view=burndown",
    "Raumtechnik Demo",
    "_desktop.projects.$slug/route.tsx:162 + seed data.ts:326",
  ],
  ["notes", "/notes", "Notizen", "_desktop.notes._index/route.tsx:66"],
  [
    "note-editor",
    "/notes/seed_note_06",
    "Standorte und Zuständigkeiten",
    "_desktop.notes.$id/route.tsx:120 + seed data.ts:664",
  ],
  ["activity", "/activity", "Aktivität", "_desktop.activity/route.tsx:111"],
  ["search", "/search?q=Lager", "Suche", "_desktop.search/route.tsx:54"],
  ["search-mischpult", "/search?q=Mischpult", "Suche", "_desktop.search/route.tsx:54"],
  ["timesheet", "/timesheet", "Zeiterfassung", "_desktop.timesheet/route.tsx:184"],
  ["capacity", "/capacity", "Kapazität", "_desktop.capacity/route.tsx:45"],
  ["import", "/import", "Import / Export", "_desktop.import/route.tsx:87"],
  ["admin-index", "/admin/index", "Suchindex", "_desktop.admin.index/route.tsx:88"],
  ["m", "/m", "Eintrag erfassen", "m._index/route.tsx:141"],
  ["m-board", "/m/board", "Board", "m.board/route.tsx:42"],
  ["m-search", "/m/search?q=Lager", "Suche", "m.search/route.tsx:31"],
  ["m-tasks-new", "/m/tasks/new", "Aufgabe anlegen", "m.tasks.new/route.tsx:75"],
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const [name, path, marker] of ROUTES) {
    test(`@screens ${name} [${theme}]`, async ({ page, baseURL }) => {
      await page
        .context()
        .addCookies([{ name: "theme", value: theme, url: themeCookieOrigin(baseURL) }]);
      if (name.startsWith("m")) await page.setViewportSize({ width: 390, height: 844 });
      // Assert the route-specific <h1> BEFORE the capture (surviving a
      // first-visit Vite re-optimisation — see gotoAndAssertMarker). The login
      // shell's <h1> is "Jiangtang" (login/route.tsx:45), so a lost session, a
      // 404, or an "Application Error" crash fails here instead of writing a
      // plausible-looking PNG.
      await gotoAndAssertMarker(page, path, marker);
      await page.waitForTimeout(400); // let fonts/hydration settle before capture
      await page.screenshot({
        path: `test-results/screens/${name}-${theme}.png`,
        fullPage: true,
      });
    });
  }

  // Interactive: the ask box after a question. On a zero-config box (no
  // generation provider) /api/ask answers `results-only` — reason + cited
  // hits, never an error. With a provider configured it streams instead;
  // either terminal state is a valid screenshot.
  test(`@screens search-ask [${theme}]`, async ({ page, baseURL }) => {
    await page
      .context()
      .addCookies([{ name: "theme", value: theme, url: themeCookieOrigin(baseURL) }]);
    await page.goto("/search?q=Mischpult");
    await page.waitForLoadState("load");
    // Without this the submit can race hydration and fall through to the
    // native GET form (?question=…) instead of the React onSubmit → /api/ask.
    await page.waitForSelector("html[data-hydrated]");
    await page.locator('input[name="question"]').fill("Welches Mischpult hängt in A.01?");
    await page.getByRole("button", { name: "Fragen" }).click();
    // loading → results-only (no provider) or done (provider); wait for either.
    await expect(
      page.locator("section").filter({ hasText: "Frage stellen" }).locator("ul, ol").first(),
    ).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(300);
    await page.screenshot({
      path: `test-results/screens/search-ask-${theme}.png`,
      fullPage: true,
    });
  });
}
