import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";
import { propertiesForKind } from "~/lib/equipment-kinds/properties";

const deviceIds: string[] = [],
  modelIds: string[] = [];
const renders = "test-results/model-values";
test.afterEach(async () => {
  await db.equipment.deleteMany({ where: { id: { in: deviceIds.splice(0) } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: modelIds.splice(0) } } });
});
test.afterAll(() => db.$disconnect());
async function widthCheck(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator("aside").first().isVisible()).toBe(true);
}

for (const locale of ["de", "en"] as const)
  for (const density of ["comfortable", "compact"] as const) {
    test(`a model value reaches both projectors in ${locale} ${density}`, async ({
      page,
      baseURL,
    }) => {
      test.setTimeout(180_000);
      const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
      const light = await db.customField.findUniqueOrThrow({
        where: { systemKey: "projector.light_source" },
        include: { options: true },
      });
      const mode = await db.customField.findUniqueOrThrow({
        where: { systemKey: "projector.projection_mode" },
      });
      const model = await db.equipmentModel.create({
        data: {
          manufacturer: "Epson",
          name: `${runPrefix()}EB-L1750U`,
          category: "PROJECTOR",
          kindId: kind.id,
        },
      });
      modelIds.push(model.id);
      const devices = [];
      for (let n = 0; n < 2; n++) {
        const device = await db.equipment.create({
          data: {
            name: `${runPrefix()}Projector ${n + 1}`,
            category: "PROJECTOR",
            kindId: kind.id,
            modelId: model.id,
            customValues: { [mode.id]: "Front / ceiling" },
          },
        });
        deviceIds.push(device.id);
        devices.push(device);
      }
      mkdirSync(renders, { recursive: true });
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);
      await page.setViewportSize({ width: 1280, height: 1000 });
      const capture = async (name: string) => {
        await widthCheck(page);
        await page.screenshot({ path: `${renders}/${name}-${locale}-${density}.png` });
      };
      await page.goto(`/inventory/models/${model.id}`);
      await page.getByText(t(locale, "inventory.models.editSummary"), { exact: true }).click();
      const input = page.locator(`select[id="cf.${light.id}"]`);
      await expect(input).toBeVisible();
      await input.selectOption(light.options.find((option) => option.systemKey === "laser")!.id);
      await page
        .getByRole("button", { name: t(locale, "inventory.models.submit"), exact: true })
        .click();
      await expect(
        page.getByText(t(locale, "inventory.models.saved"), { exact: true }),
      ).toBeVisible();
      await page
        .locator("form section")
        .filter({
          has: page.getByRole("heading", { name: t(locale, "fields.model.sheet"), exact: true }),
        })
        .scrollIntoViewIfNeeded();
      await capture("model-form");
      for (const device of devices) {
        await page.goto(`/inventory/${device.id}`);
        const from = page.locator("section").filter({
          has: page.getByRole("heading", { name: t(locale, "fields.model.from"), exact: true }),
        });
        await expect(from).toContainText("Laser");
        await expect(page.locator(`select[id="cf.${light.id}"]`)).toHaveCount(0);
      }
      const own = page.locator("section").filter({
        has: page.getByRole("heading", { name: t(locale, "fields.device.own"), exact: true }),
      });
      await own.getByRole("button").click();
      await expect(own).toContainText("Front / ceiling");
      await capture("projector-page");
      await page
        .getByRole("link", { name: t(locale, "fields.model.edit"), exact: true })
        .first()
        .scrollIntoViewIfNeeded();
      await capture("device-form");
      await page.goto(`/admin/structure?tab=fields&scope=EQUIPMENT&kind=${kind.id}`);
      const library = page.locator("details").filter({
        has: page.getByText(
          t(locale, "fields.library.title", { count: propertiesForKind("projector").length }),
          { exact: true },
        ),
      });
      await library.locator("summary").click();
      await expect(library).toContainText(locale === "de" ? "Lichtquelle" : "Light source");
      await library.locator("summary").scrollIntoViewIfNeeded();
      await capture("fields-tab");
      await page.setViewportSize({ width: 1920, height: 1080 });
      await widthCheck(page);
      await page.goto("/inventory");
      await widthCheck(page);
    });
  }
