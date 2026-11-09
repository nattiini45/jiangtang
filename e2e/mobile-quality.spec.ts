import { test, expect, type Locator } from "@playwright/test";
import { db } from "~/lib/db.server";
import { runPrefix } from "./run";
import {
  createStockItem,
  deleteStockItem,
} from "~/domains/inventory/inventory.stock.mutations.server";
import { stockCreateSchema } from "~/domains/inventory/inventory.stock.schema";
import { AxeBuilder } from "@axe-core/playwright";

const RUN = runPrefix();

test.use({ viewport: { width: 390, height: 600 } });

async function expectTarget(target: Locator, minimum = 44) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(minimum);
  expect(box!.width).toBeGreaterThanOrEqual(minimum);
}

test.afterAll(async () => {
  await db.$disconnect();
});

for (const viewport of [
  { width: 390, height: 600 },
  { width: 844, height: 390 },
]) {
  test(`More traps and restores focus, locks the document and scrolls every destination at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/m");
    await page.waitForSelector("html[data-hydrated]");
    const more = page.getByRole("button", { name: "Mehr", exact: true });
    await more.click();
    const dialog = page.getByRole("dialog", { name: "Mehr", exact: true });
    const close = dialog.getByRole("button", { name: "Menü schließen" });
    await expect(close).toBeFocused();
    await page.locator("header a").evaluate((element: HTMLAnchorElement) => element.focus());
    await expect(close).toBeFocused();
    await expect(page.locator("html")).toHaveCSS("overflow", "hidden");
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("button", { name: "Desktop-Version" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    const accessibility = await new AxeBuilder({ page })
      .include("dialog")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
      .analyze();
    expect(accessibility.violations).toEqual([]);

    const links = dialog.getByRole("navigation").getByRole("link");
    await expect(links).toHaveCount(11);
    for (const link of await links.all()) {
      await link.scrollIntoViewIfNeeded();
      await expect(link).toBeInViewport({ ratio: 1 });
      await expectTarget(link);
    }
    for (const target of [
      dialog.getByRole("button", { name: "DE Deutsch" }),
      dialog.getByRole("button", { name: "EN English" }),
      dialog.getByRole("button", { name: "Abmelden" }),
      dialog.getByRole("button", { name: "Desktop-Version" }),
    ]) {
      await target.scrollIntoViewIfNeeded();
      await expect(target).toBeInViewport({ ratio: 1 });
      await expectTarget(target);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(more).toBeFocused();
    await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");
    await more.click();
    await page.mouse.click(2, 2);
    await expect(dialog).not.toBeVisible();
    await expect(more).toBeFocused();
  });
}

test("navigation exposes its busy state visually and to assistive technology", async ({ page }) => {
  await page.goto("/m");
  await page.waitForSelector("html[data-hydrated]");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/m\/tickets\.data(?:\?|$)/, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.getByRole("link", { name: "Tickets", exact: true }).click();
    await expect(page.locator("main")).toHaveAttribute("aria-busy", "true");
    await expect(page.getByRole("status").filter({ hasText: "Wird geladen…" })).toHaveText(
      "Wird geladen…",
    );
    await expect(page.locator(".mobile-shell > div[aria-hidden=false]")).toHaveCSS("opacity", "1");
  } finally {
    release();
  }
  await expect(page).toHaveURL(/\/m\/tickets$/);
  await expect(page.locator("main")).toHaveAttribute("aria-busy", "false");
});

test("long task titles and due dates remain readable, with a reachable Blocked action", async ({
  page,
}) => {
  const title = `${RUN}Medientechnik-Verbindungsprüfung im Hörsaal: Projektionsanlage und Signalverteilung vollständig kontrollieren`;
  await page.goto("/m/tasks/new");
  await page.waitForSelector("html[data-hydrated]");
  await page.getByLabel("Titel", { exact: true }).fill(title);
  await page.getByLabel("Fällig am").fill("2027-03-31");
  await page.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page).toHaveURL(/\/m\/tasks\/(?!new$)[^/]+$/);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const blocked = page.getByRole("button", { name: "Blockiert", exact: true });
  await expectTarget(blocked);
  await blocked.click();
  await expect(blocked).toBeDisabled();
  expect((await db.task.findUniqueOrThrow({ where: { id } })).status).toBe("BLOCKED");
  await page.goto("/m/tasks?all=1");
  const row = page.getByRole("link").filter({ hasText: title });
  await expect(row).toContainText("31.03.2027");
  const titleElement = row.locator("div").first();
  await expect(titleElement).toHaveText(title);
  expect(await titleElement.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  await expect(titleElement).not.toHaveCSS("white-space", "nowrap");
  await row.focus();
  const box = await row.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(56);
  expect(box!.y + box!.height).toBeLessThanOrEqual(536);
  await expect(row).toHaveCSS("outline-offset", "-3px");
  await page
    .context()
    .addCookies([{ name: "locale", value: "en", url: new URL(page.url()).origin }]);
  await page.reload();
  await expect(page.getByRole("link").filter({ hasText: title })).toContainText("31 Mar 2027");
});

test("ticket capture confirms the saved ticket and cancellation requires a deliberate choice", async ({
  page,
}) => {
  const title = `${RUN}Mikrofonempfänger im Hörsaal überprüfen`;
  await page.goto("/m");
  await page.waitForSelector("html[data-hydrated]");
  await expectTarget(page.getByRole("link", { name: "Benachrichtigungen", exact: true }));
  await page.getByLabel("Was ist los?").fill(title);
  const submit = page.getByRole("button", { name: "Eintrag erfassen", exact: true });
  await expectTarget(submit, 48);
  await submit.click();
  await expect(page).toHaveURL(/\/m\/tickets\/[^/?]+\?created=1$/);
  await expect(
    page.getByRole("status").filter({ hasText: "Eintrag gespeichert. Hier ist dein Ticket." }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const cancel = page.getByRole("button", { name: "Ticket stornieren", exact: true });
  page.once("dialog", (dialog) => dialog.dismiss());
  await cancel.click();
  expect((await db.ticket.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain(title);
    await dialog.accept();
  });
  await cancel.click();
  const reopen = page.getByRole("button", { name: "Wieder öffnen", exact: true });
  await expect(reopen).toBeVisible();
  expect((await db.ticket.findUniqueOrThrow({ where: { id } })).status).toBe("CANCELLED");
  await reopen.click();
  await page
    .getByLabel("Als gelöst markieren")
    .fill("Empfänger neu verbunden und Funktion geprüft.");
  const resolve = page.getByRole("button", { name: "Lösen", exact: true });
  await expectTarget(resolve, 48);
  await resolve.click();
  await expect(reopen).toBeVisible();
  expect((await db.ticket.findUniqueOrThrow({ where: { id } })).status).toBe("RESOLVED");
});

test("ticket and stock searches preserve their current filters and explain no results", async ({
  page,
}) => {
  await page.goto("/m/tickets?status=OPEN");
  await page.getByLabel("Tickets durchsuchen").fill(`${RUN}keine-treffer`);
  await page.getByRole("button", { name: "Suche", exact: true }).click();
  await expect(page).toHaveURL(/status=OPEN/);
  await expect(page.getByRole("link", { name: "In Arbeit", exact: true })).toHaveAttribute(
    "href",
    /q=.*status=IN_PROGRESS/,
  );
  await expect(page.getByRole("link", { name: "Filter entfernen" })).toBeVisible();
  await page.goto("/m/inventory/stock?hideUnassigned=1");
  await page.getByLabel("Lager durchsuchen").fill(`${RUN}kein-artikel`);
  await page.getByRole("button", { name: "Suche", exact: true }).click();
  await expect(page).toHaveURL(/hideUnassigned=1/);
  await expect(page.getByRole("link", { name: "Filter entfernen" })).toBeVisible();
});

for (const locale of ["de", "en"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`long stock identifiers and names wrap in ${locale}, ${theme}`, async ({
      page,
      baseURL,
    }) => {
      const actor = await db.user.findFirstOrThrow({ where: { email: process.env.ADMIN_EMAIL } });
      const name = `${RUN}${locale}-${theme}-Hörsaalsteuerungs-Verbindungskabel für die audiovisuelle Signalverteilung`;
      const serial = `${RUN}${locale}-${theme}-${"1234567890".repeat(8)}`;
      const item = await createStockItem(actor, stockCreateSchema.parse({ name, serial }));
      try {
        await page.context().addCookies([
          { name: "locale", value: locale, url: baseURL! },
          { name: "theme", value: theme, url: baseURL! },
        ]);
        await page.goto(`/m/inventory/stock?q=${encodeURIComponent(name)}`);
        const row = page.getByRole("link").filter({ hasText: name });
        await expect(row).toContainText(serial);
        for (const element of [row.locator("p").first(), row.locator(".font-mono")]) {
          expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
          await expect(element).not.toHaveCSS("white-space", "nowrap");
        }
        expect(
          await page.locator("main").evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
        await expect(row.locator("p").first()).toHaveCSS("font-size", "14px");
        await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*dark)/);
        await row.click();
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
        await expect(page.locator("dd").filter({ hasText: serial })).toBeVisible();
      } finally {
        await deleteStockItem(actor, item.id);
      }
    });
  }
}

test("week navigation has a separate readable row and mobile form fields meet the touch floor", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/m/timesheet?week=2026-W45");
  await expect(page.getByRole("heading", { level: 2 })).toHaveText("Woche 45 · 2026");
  const more = page.getByRole("button", { name: "Mehr", exact: true });
  await expect(more).toHaveAttribute("aria-current", "true");
  await expectTarget(page.getByRole("link", { name: "Vorherige Woche" }));
  await expectTarget(page.getByRole("link", { name: "Nächste Woche" }));
  await page.goto("/m/events/new");
  for (const field of await page.locator('main input:not([type="hidden"]), main select').all()) {
    await expectTarget(field);
  }
  const date = await page.getByLabel("Datum", { exact: true }).boundingBox();
  const start = await page.getByLabel("Von", { exact: true }).boundingBox();
  const end = await page.getByLabel("Bis", { exact: true }).boundingBox();
  expect(date!.width).toBeGreaterThan(300);
  expect(start!.width).toBeGreaterThan(150);
  expect(end!.width).toBeGreaterThan(150);
  expect(start!.y).toBe(end!.y);
  expect(start!.y).toBeGreaterThan(date!.y);
});

test("a missing mobile task keeps its 404 status and offers capture recovery", async ({ page }) => {
  const response = await page.goto(`/m/tasks/${RUN}missing`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Eintrag nicht gefunden");
  const recovery = page.getByRole("link", { name: "Zur Erfassung", exact: true });
  await expectTarget(recovery);
  await recovery.click();
  await expect(page).toHaveURL(/\/m$/);
});

test("the photo picker allows an existing photo without forcing the camera", async ({ page }) => {
  await page.goto("/m");
  await page.waitForSelector("html[data-hydrated]");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Foto auswählen", exact: true }).click();
  await expect(page.locator('input[type="file"]')).not.toHaveAttribute("capture");
  await (
    await chooser
  ).setFiles({
    name: "synthetic-photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  });
  await expect(
    page.getByRole("status").filter({ hasText: "Ausgewählte Fotos: 1. Noch nicht hochgeladen." }),
  ).toBeVisible();
});
