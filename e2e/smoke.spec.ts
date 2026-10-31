import { test, expect, type Page } from "@playwright/test";

/**
 * Smoke: the main surfaces render for a signed-in admin with no console
 * errors and no uncaught page errors.
 *
 * "A page rendered" is NOT success. The old oracle
 * `page.locator("main, [role='main'], body").first()` ends in `body`, which is
 * visible on ANY rendered page — a stub serving one signed-out login shell for
 * all six routes passed 6/6 with exit 0. Each surface below now asserts its
 * route-specific <h1>, taken from the real component (cited per row), plus the
 * fact that the browser did not end on /login. The login shell's own <h1> is
 * "Jiangtang" (app/routes/login/route.tsx:45), so no signed-out shell can
 * satisfy any row. A negative control confirms the assertion can fail.
 */

async function collectErrors(page: Page, path: string) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (msg) => {
    const text = msg.text();
    // Fix gate: no hydration diagnostics on any surface (the board's
    // stable DndContext id should have ended them — catch a regression at any
    // console level, not just "error").
    if (/hydrat/i.test(text)) {
      errors.push(`console.${msg.type()}: ${text}`);
      return;
    }
    if (msg.type() !== "error") return;
    errors.push(`console.error: ${text}`);
  });
  await page.goto(path);
  // The realtime EventSource stays open forever — networkidle never settles.
  await page.waitForLoadState("load");
  await page.waitForTimeout(1000); // let hydration + console errors surface
  return errors;
}

// Each row: [name, path, expected <h1> text, oracle source file:line]. The
// <h1> text is copied verbatim from the route component that renders it, cited
// in the 4th column so a future rename is caught here. The 4th column is
// documentation only (not bound) — the assertion uses the accessible heading.
for (const [name, path, h1] of [
  ["dashboard", "/", "Übersicht", "app/routes/_desktop._index/route.tsx:150"],
  ["tasks", "/tasks", "Aufgaben", "app/routes/_desktop.tasks._index/route.tsx:120"],
  ["board", "/board", "Board", "app/routes/_desktop.board/route.tsx:157"],
  ["notes", "/notes", "Notizen", "app/routes/_desktop.notes._index/route.tsx:66"],
  ["search", "/search?q=Lager", "Suche", "app/routes/_desktop.search/route.tsx:54"],
  ["activity", "/activity", "Aktivität", "app/routes/_desktop.activity/route.tsx:111"],
] as const) {
  test(`${name} renders without console errors`, async ({ page }) => {
    const errors = await collectErrors(page, path);
    // Assert the route-specific <h1> (accessible heading, level 1, exact
    // name) that only THIS surface renders. The login shell's <h1> is
    // "Jiangtang" (app/routes/login/route.tsx:45), so a signed-out shell cannot
    // satisfy any row here.
    await expect(page.getByRole("heading", { level: 1, name: h1, exact: true })).toBeVisible();
    // An auth redirect masquerading as success. The final URL must not
    // be the login route — a lost session that bounced here would render the
    // login shell (h1 "Jiangtang"), failing the heading assertion above, and
    // this check names the cause explicitly.
    expect(new URL(page.url()).pathname).not.toBe("/login");
    expect(errors).toEqual([]);
  });
}
