import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const ROUTES = [
  ["home", "/m", "Übersicht"],
  ["capture", "/m/quick-entry", "Eintrag erfassen"],
  ["board", "/m/board", "Board"],
  ["events", "/m/events", "Veranstaltungen"],
  ["event-new", "/m/events/new", "Veranstaltung anlegen"],
  ["event-detail", "/m/events/seed_event_hybrid", "Demo-Hybridveranstaltung"],
  ["stock", "/m/inventory/stock", "Lager"],
  ["stock-detail", "/m/inventory/stock/seed_inv_01", "HDMI-Kabel 5m"],
  ["locations", "/m/locations", "Standorte"],
  ["notes", "/m/notes", "Notizen"],
  ["note-new", "/m/notes/new", "Notiz anlegen"],
  ["note-detail", "/m/notes/seed_note_01", "Zugang und Sicherheitskonzept Demo-Standort"],
  ["notifications", "/m/notifications", "Benachrichtigungen"],
  ["offline", "/m/offline", "Offline"],
  ["projects", "/m/projects", "Projekte"],
  ["rooms", "/m/rooms", "Räume"],
  ["room-detail", "/m/rooms/demo-a01", "Demo-Raum A.01"],
  ["search", "/m/search?q=Lager", "Suche"],
  ["tasks", "/m/tasks?all=1", "Aufgaben"],
  ["task-detail", "/m/tasks/seed_task_hs_01", "Beamer-Vergleich 2025 durchführen"],
  ["task-new", "/m/tasks/new", "Aufgabe anlegen"],
  ["tickets", "/m/tickets", "Tickets"],
  ["ticket-detail", "/m/tickets/seed_tkt_01", "Beamer A.05 bleibt dunkel"],
  ["timesheet", "/m/timesheet", "Zeiterfassung"],
] as const;

test.use({
  viewport: { width: 390, height: 844 },
  locale: "de-DE",
  isMobile: true,
  hasTouch: true,
});

for (const theme of ["light", "dark"] as const) {
  for (const [name, path, marker] of ROUTES) {
    test(`@screens mobile ${name} [${theme}]`, async ({ page, baseURL }) => {
      await page.context().addCookies([
        { name: "theme", value: theme, url: new URL(baseURL!).origin },
        { name: "locale", value: "de", url: new URL(baseURL!).origin },
        { name: "view", value: "mobile", url: new URL(baseURL!).origin },
      ]);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const heading = page.getByRole("heading", { level: 1, name: marker, exact: true });
      await page.goto(path, { waitUntil: "load" });
      await expect(heading).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", "de");
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^$/);
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
        .analyze();
      expect(accessibility.violations).toEqual([]);
      await page.screenshot({
        path: `test-results/mobile-screens/${name}-${theme}.png`,
        fullPage: true,
      });
    });
  }
  test(`@screens mobile more [${theme}]`, async ({ page, baseURL }) => {
    await page.context().addCookies([
      { name: "theme", value: theme, url: new URL(baseURL!).origin },
      { name: "locale", value: "de", url: new URL(baseURL!).origin },
      { name: "view", value: "mobile", url: new URL(baseURL!).origin },
    ]);
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.goto("/m");
    await page.waitForSelector("html[data-hydrated]");
    await page.getByRole("button", { name: "Mehr", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Mehr", exact: true })).toBeVisible();
    const accessibility = await new AxeBuilder({ page })
      .include("dialog")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.waitForTimeout(500);
    await page.screenshot({
      path: `test-results/mobile-screens/more-${theme}.png`,
      fullPage: true,
    });
  });
}
