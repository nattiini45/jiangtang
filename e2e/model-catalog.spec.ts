import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { reconcileModelCatalog } from "~/domains/catalog/catalog.library.server";
import { txWithAudit } from "~/lib/audit.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const modelIds: string[] = [],
  deviceIds: string[] = [];
const renders = "test-results/model-catalog";
test.afterEach(async () => {
  await db.equipment.deleteMany({ where: { id: { in: deviceIds.splice(0) } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: modelIds.splice(0) } } });
});
test.afterAll(() => db.$disconnect());
async function widthCheck(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator("aside").first()).toBeVisible();
}

for (const locale of ["de", "en"] as const)
  for (const density of ["comfortable", "compact"] as const) {
    test(`a picked projector arrives complete in ${locale} ${density}`, async ({
      page,
      baseURL,
    }) => {
      test.setTimeout(180_000);
      const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
      const room = await db.room.findFirstOrThrow();
      const model = await db.equipmentModel.create({
        data: { manufacturer: "Epson", name: "EB-L1750U", category: "PROJECTOR", kindId: kind.id },
      });
      modelIds.push(model.id);
      for (let n = 0; n < 2; n++) {
        const unit = await db.equipment.create({
          data: {
            name: `${runPrefix()}Synthetic projector ${n + 1}`,
            category: "PROJECTOR",
            kindId: kind.id,
            modelId: model.id,
            roomId: room.id,
          },
        });
        deviceIds.push(unit.id);
      }
      await txWithAudit(null, async (_tx, audit) => {
        for (let n = 0; n < 37; n++)
          await audit({
            action: "LibraryPropertyReconciled",
            entityType: "customField",
            entityId: `synthetic-legacy-${n}`,
          });
      });
      await reconcileModelCatalog();
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);
      await page.setViewportSize({ width: 1280, height: 1000 });
      mkdirSync(renders, { recursive: true });
      const capture = async (name: string) => {
        if (name === "projector") await page.setViewportSize({ width: 1280, height: 1440 });
        await widthCheck(page);
        await page.screenshot({ path: `${renders}/${name}-${locale}-${density}.png` });
        if (name === "projector") await page.setViewportSize({ width: 1280, height: 1000 });
      };
      await page.goto(`/inventory/models/${model.id}`);
      await expect(
        page.getByRole("link", { name: t(locale, "inventory.catalog.productPage"), exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: t(locale, "inventory.catalog.manual"), exact: true }),
      ).toHaveAttribute("href", /epson/);
      await expect(
        page
          .locator("[data-field-values]")
          .getByText(t(locale, "fields.moreDetails"), { exact: true }),
      ).toHaveCount(0);
      await capture("linked-model");
      for (const id of deviceIds) {
        await page.goto(`/inventory/${id}`);
        const from = page.locator("section").filter({
          has: page.getByRole("heading", { name: t(locale, "fields.model.from"), exact: true }),
        });
        await expect(from).toContainText("Laser");
        await expect(from).toContainText(locale === "de" ? "15.000 lm" : "15,000 lm");
        await expect(from).toContainText("1920 × 1200");
        await from.getByRole("button").click();
        for (const value of ["3LCD", "Crestron", "Extron", "AMX"])
          await expect(from).toContainText(value);
        await expect(
          page.getByRole("link", { name: t(locale, "inventory.catalog.manual"), exact: true }),
        ).toBeVisible();
        expect(await db.equipmentPort.count({ where: { equipmentId: id } })).toBe(12);
        await from.getByRole("button").click();
      }
      await capture("projector");
      await page.goto(`/inventory/new?roomId=${room.id}`);
      await page
        .getByRole("searchbox", { name: t(locale, "inventory.catalog.search"), exact: true })
        .fill("EB-L1750U");
      const select = page.getByLabel(t(locale, "inventory.form.model"), { exact: true });
      await expect(select.locator("option").filter({ hasText: "Epson EB-L1750U" })).toHaveCount(1);
      await select.selectOption(model.id);
      await select.focus();
      await capture("device-form");
      await page
        .getByRole("button", { name: t(locale, "inventory.new.submit"), exact: true })
        .click();
      await expect(page).not.toHaveURL(/\/inventory\/new/);
      await expect(page).toHaveURL(/\/inventory\/[^/?]+$/);
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      deviceIds.push(id);
      await expect(
        page.getByText(locale === "de" ? "15.000 lm" : "15,000 lm", { exact: true }).first(),
      ).toBeVisible();
      expect((await db.equipment.findUniqueOrThrow({ where: { id } })).modelId).toBe(model.id);
      expect(
        await db.equipmentModel.count({ where: { manufacturer: "Epson", name: "EB-L1750U" } }),
      ).toBe(1);
      expect(await db.equipmentPort.count({ where: { equipmentId: id } })).toBe(12);
      await page.goto("/activity");
      for (const action of [
        "LibraryPropertyReconciled",
        "CatalogModelLinked",
        "CatalogDevicePortsFilled",
      ])
        await expect(
          page
            .getByText(
              t(locale, `history.action.${action}` as "history.action.LibraryPropertyReconciled"),
              { exact: true },
            )
            .first(),
        ).toBeVisible();
      await expect(page.getByText("Jiangtang", { exact: true }).first()).toBeVisible();
      await capture("activity");
      await page.setViewportSize({ width: 1920, height: 1080 });
      await widthCheck(page);
      await page.goto("/inventory/models");
      await widthCheck(page);

      await page.goto(`/inventory/new?roomId=${room.id}`);
      await page
        .getByRole("searchbox", { name: t(locale, "inventory.catalog.search"), exact: true })
        .fill("EB-PU1008W");
      await expect(select.locator('option[value="catalog:epson-eb-pu1008w"]')).toHaveCount(1);
      await select.selectOption("catalog:epson-eb-pu1008w");
      await page
        .getByRole("button", { name: t(locale, "inventory.new.submit"), exact: true })
        .click();
      await expect(page).not.toHaveURL(/\/inventory\/new/);
      await expect(page).toHaveURL(/\/inventory\/[^/?]+$/);
      const freshId = new URL(page.url()).pathname.split("/").at(-1)!;
      deviceIds.push(freshId);
      const fresh = await db.equipment.findUniqueOrThrow({ where: { id: freshId } });
      modelIds.push(fresh.modelId!);
      expect(await db.equipmentModel.findUnique({ where: { id: fresh.modelId! } })).toMatchObject({
        catalogKey: "epson-eb-pu1008w",
      });
      expect(await db.equipmentPort.count({ where: { equipmentId: freshId } })).toBeGreaterThan(0);
    });
  }
