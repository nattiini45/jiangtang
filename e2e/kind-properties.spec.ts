import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { reconcileLibrary } from "~/lib/custom-fields/library.server";
import { propertiesForKind } from "~/lib/equipment-kinds/properties";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const ids: string[] = [];
const renders = "test-results/kind-properties";
test.afterEach(async () => {
  await db.equipment.deleteMany({ where: { id: { in: ids.splice(0) } } });
});
test.afterAll(() => db.$disconnect());

async function widthCheck(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator("aside").first()).toBeVisible();
}

for (const locale of ["de", "en"] as const)
  for (const density of ["comfortable", "compact"] as const) {
    test(`kinds bring properties and range inputs in ${locale} ${density}`, async ({
      page,
      baseURL,
    }) => {
      test.setTimeout(180_000);
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
      const microphone = await db.equipmentKind.findUniqueOrThrow({
        where: { systemKey: "microphone" },
      });
      const projector = await db.equipmentKind.findUniqueOrThrow({
        where: { systemKey: "projector" },
      });
      const mic = await db.equipment.create({
        data: {
          name: `${runPrefix()}Wireless microphone`,
          category: "MICROPHONE",
          kindId: microphone.id,
          mobility: "POOLED",
          micKind: "HANDHELD",
          frequencyMhz: 823.1,
          band: "Synthetic band",
          channelLabel: "Synthetic channel",
        },
      });
      const proj = await db.equipment.create({
        data: {
          name: `${runPrefix()}Projector`,
          category: "PROJECTOR",
          kindId: projector.id,
          mobility: "POOLED",
        },
      });
      ids.push(mic.id, proj.id);
      await reconcileLibrary();
      await page.goto(`/inventory/${mic.id}`);
      const own = page.locator("section").filter({
        has: page.getByRole("heading", { name: t(locale, "fields.device.own"), exact: true }),
      });
      await own.getByRole("button").click();
      await expect(own).toContainText("Synthetic channel");
      await expect(own).toContainText(locale === "de" ? "823,1" : "823.1");
      await capture("microphone-page");
      const frequency = await db.customField.findUniqueOrThrow({
        where: { systemKey: "frequency" },
      });
      const frequencyInput = page.locator(`input[id="cf.${frequency.id}"]`);
      await page
        .locator("details")
        .filter({ has: frequencyInput })
        .locator("summary")
        .first()
        .click();
      await expect(frequencyInput).toHaveValue("823.1");
      await frequencyInput.fill(locale === "de" ? "824,125" : "824.125");
      await frequencyInput.scrollIntoViewIfNeeded();
      await capture("microphone-form");
      await page
        .getByRole("button", { name: t(locale, "inventory.detail.submit"), exact: true })
        .click();
      await expect(own).toContainText(locale === "de" ? "824,125" : "824.125");
      expect(
        Number((await db.equipment.findUniqueOrThrow({ where: { id: mic.id } })).frequencyMhz),
      ).toBe(824.125);
      await page.goto(`/inventory/${proj.id}`);
      const range = await db.customField.findUniqueOrThrow({
        where: { systemKey: "projector.throw_ratio" },
      });
      const min = page.locator(`input[id="cf.${range.id}.min"]`);
      const max = page.locator(`input[id="cf.${range.id}.max"]`);
      await page.locator("details").filter({ has: min }).locator("summary").first().click();
      await min.fill(locale === "de" ? "1,35" : "1.35");
      await max.fill(locale === "de" ? "2,20" : "2.20");
      await min.scrollIntoViewIfNeeded();
      await capture("projector-form");
      await page
        .getByRole("button", { name: t(locale, "inventory.detail.submit"), exact: true })
        .click();
      const device = page.locator("section").filter({
        has: page.getByRole("heading", { name: t(locale, "fields.device.own"), exact: true }),
      });
      await device.getByRole("button").click();
      await expect(device).toContainText(locale === "de" ? "1,35–2,20 : 1" : "1.35–2.20 : 1");
      await device.scrollIntoViewIfNeeded();
      await capture("projector-page");
      await page.goto(`/admin/structure?tab=fields&scope=EQUIPMENT&kind=${microphone.id}`);
      const library = page.locator("details").filter({
        has: page.getByText(
          t(locale, "fields.library.title", { count: propertiesForKind("microphone").length }),
          { exact: true },
        ),
      });
      await library.locator("summary").click();
      await expect(library).toContainText(locale === "de" ? "Trägerfrequenz" : "Carrier frequency");
      await library.scrollIntoViewIfNeeded();
      await capture("fields-tab");
      await page.setViewportSize({ width: 1920, height: 1080 });
      await widthCheck(page);
    });
  }
