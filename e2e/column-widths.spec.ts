import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { runPrefix } from "./run";

let campusId: string;
test.beforeAll(async () => {
  const campus = await db.campus.create({
    data: { name: "Westpark", slug: `${runPrefix()}widths` },
  });
  campusId = campus.id;
  await db.room.createMany({
    data: Array.from({ length: 70 }, (_, i) => ({
      name: `Veranstaltungssaal ${String(i + 1).padStart(2, "0")} · Westflügel`,
      slug: `${runPrefix()}widths-${i}`,
      campusId,
      roomNumber: `W.${String(i + 1).padStart(2, "0")}`,
      capacity: 120,
      knownIssues: "Mikrofon am Rednerpult ohne Signal",
      lastCheckedAt: new Date("2026-10-01T12:00:00Z"),
    })),
  });
});
test.afterAll(async () => {
  if (campusId) {
    await db.room.deleteMany({ where: { campusId } });
    await db.campus.delete({ where: { id: campusId } });
  }
  await db.$disconnect();
});

test("drag, reload, keyboard, fit and reset room column widths", async ({ page }) => {
  await page.goto(`/rooms?campus=${campusId}`);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("cell").first()).toBeVisible();
  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect
      .poll(() =>
        page
          .getByRole("columnheader")
          .first()
          .evaluate((el) => el.clientWidth),
      )
      .toBeGreaterThan(140);
    await page.screenshot({ path: `test-results/column-widths/rooms-${width}.png` });
  }
  const header = page.locator('[role="columnheader"][data-column-id="knownIssues"]');
  const width = () => header.evaluate((element) => element.getBoundingClientRect().width);
  const initial = await width();
  const campus = page.locator('[role="cell"][data-column-id="campusName"]').first();
  await expect(campus).toHaveAttribute("title", "Westpark");
  await expect.poll(() => header.evaluate((element) => element.clientWidth)).toBeGreaterThan(300);
  const handle = header.getByRole("separator");
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(width).toBeCloseTo(Math.round(initial + 110), 0);
  const resized = await width();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  await expect.poll(width).toBeCloseTo(resized, 0);
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBeCloseTo(resized + 10, 0);
  await handle.dblclick();
  await expect.poll(width).toBeLessThan(resized);
  await expect(header).not.toHaveAttribute("aria-sort");
  await page.getByRole("button", { name: "Spalten", exact: true }).click();
  await page.getByRole("button", { name: "Spaltenbreiten zurücksetzen", exact: true }).click();
  await expect.poll(width).toBeCloseTo(initial, 0);
  await page.reload();
  await expect.poll(width).toBeCloseTo(initial, 0);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.locator('[role="columnheader"][data-column-id="name"]').getByRole("separator").focus();
  await page.keyboard.press("ArrowRight");
  const nameWidth = await page
    .locator('[role="columnheader"][data-column-id="name"]')
    .evaluate((el) => el.clientWidth);
  await page.goto("/inventory?tab=models");
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  await expect
    .poll(() =>
      page.locator('[role="columnheader"][data-column-id="name"]').evaluate((el) => el.clientWidth),
    )
    .not.toBe(nameWidth);
  const modelHeader = page.locator('[role="columnheader"][data-column-id="name"]');
  await modelHeader.getByRole("separator").focus();
  await page.keyboard.press("ArrowRight");
  const modelWidth = await modelHeader.evaluate((el) => el.clientWidth);
  await page.goto("/inventory?tab=stock");
  await page.locator('[role="columnheader"][data-column-id="name"]').getByRole("separator").focus();
  await page.keyboard.press("ArrowLeft");
  await page.goto("/inventory?tab=models");
  await expect.poll(() => modelHeader.evaluate((el) => el.clientWidth)).toBe(modelWidth);
});

test("shared lists keep readable, aligned columns in both languages and densities", async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(240_000);
  for (const locale of ["de", "en"]) {
    for (const density of ["comfortable", "compact"]) {
      await context.addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
      ]);
      for (const viewport of [1280, 1920]) {
        await page.setViewportSize({ width: viewport, height: 1000 });
        for (const path of [
          `/rooms?campus=${campusId}`,
          "/inventory",
          "/inventory?tab=models",
          "/inventory?tab=stock",
          "/tickets",
          "/tasks?view=list",
          "/projects?view=list",
          "/events",
          "/functions",
          "/admin/users",
          "/admin/invitations",
        ]) {
          await page.goto(path);
          await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
          await expect(page.getByRole("columnheader").first()).toBeVisible();
          await expect
            .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
            .toBeLessThanOrEqual(1);
          await page.evaluate(() => document.fonts.ready);
          await expect
            .poll(() =>
              page.getByRole("columnheader").evaluateAll((elements) =>
                elements.every((el) => {
                  const width = el.getBoundingClientRect().width;
                  const cell = document.querySelector(
                    `[role="cell"][data-column-id="${(el as HTMLElement).dataset.columnId}"]`,
                  );
                  return (
                    width >= 64 &&
                    (!cell || Math.abs(cell.getBoundingClientRect().width - width) < 0.5)
                  );
                }),
              ),
            )
            .toBe(true);
          if (path.startsWith("/rooms") || path === "/functions")
            await page.screenshot({
              path: `test-results/column-widths/${path.startsWith("/rooms") ? "rooms" : "functions"}-${viewport}-${locale}-${density}.png`,
            });
        }
      }
    }
  }
});
