import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const modelIds: string[] = [];
const equipmentIds: string[] = [];
test("a 24-port device remains scannable at 1280 by 800", async ({ page, baseURL }) => {
  await page.context().addCookies([
    { name: "locale", value: "de", url: baseURL! },
    { name: "density", value: "comfortable", url: baseURL! },
  ]);
  await page.setViewportSize({ width: 1280, height: 800 });
  const templates = Array.from({ length: 24 }, (_, index) => ({
    label: `HDMI IN ${index + 1}`,
    connector: "HDMI",
    direction: "INPUT" as const,
    signal: "AUDIO_VIDEO" as const,
    position: index,
  }));
  const model = await db.equipmentModel.create({
    data: { name: `${runPrefix()}Matrix 24`, category: "SWITCHER", ports: { create: templates } },
  });
  modelIds.push(model.id);
  const unit = await db.equipment.create({
    data: {
      name: `${runPrefix()}Synthetic matrix`,
      category: "SWITCHER",
      mobility: "POOLED",
      modelId: model.id,
      ports: { create: templates },
    },
  });
  equipmentIds.push(unit.id);
  await page.goto(`/inventory/models/${model.id}`);
  const editor = page.getByRole("region", { name: "Anschlüsse" });
  await expect(editor.locator("fieldset")).toHaveCount(24);
  const firstRow = editor.locator("fieldset").first();
  const controls = await firstRow
    .locator("input,select")
    .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().y));
  expect(new Set(controls).size).toBe(1);
  await editor
    .getByRole("button", { name: "Anschluss HDMI IN 1 duplizieren", exact: true })
    .click();
  await expect(
    editor.getByRole("textbox", { name: "Bezeichnung", exact: true }).nth(1),
  ).toHaveValue("HDMI IN 25");
  await page.goto(`/inventory/${unit.id}`);
  const rows = page.getByRole("region", { name: "Anschlüsse" }).locator("li");
  await expect(rows).toHaveCount(24);
  const visible = await rows.evaluateAll(
    (elements) =>
      elements.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight;
      }).length,
  );
  expect(visible).toBeGreaterThanOrEqual(11);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1280);
});
test.afterAll(async () => {
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: modelIds } } });
  await db.$disconnect();
});
for (const locale of ["de", "en"] as const) {
  for (const density of ["comfortable", "compact"]) {
    test(`model and device ports in ${locale}, ${density}`, async ({ page, baseURL }) => {
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
      ]);
      await page.setViewportSize({ width: 1280, height: 900 });
      const name = `${runPrefix()}Signal station ${locale} ${density}`;
      const model = await db.equipmentModel.create({ data: { name, category: "PROJECTOR" } });
      modelIds.push(model.id);
      await page.goto(`/inventory/models/${model.id}`);
      const editor = page.getByRole("region", { name: t(locale, "ports.heading") });
      await editor.getByRole("button", { name: t(locale, "ports.add"), exact: true }).click();
      await editor
        .getByRole("textbox", { name: t(locale, "ports.label"), exact: true })
        .fill("HDMI OUT");
      await editor.getByRole("button", { name: t(locale, "ports.save"), exact: true }).click();
      await expect(
        editor.getByRole("status").filter({ hasText: t(locale, "ports.saved") }),
      ).toBeVisible();
      await editor
        .getByRole("button", {
          name: t(locale, "ports.duplicatePort", { label: "HDMI OUT" }),
          exact: true,
        })
        .click();
      await expect(
        editor.getByRole("textbox", { name: t(locale, "ports.label"), exact: true }).nth(1),
      ).toHaveValue("HDMI OUT 2");
      await editor.getByRole("button", { name: t(locale, "ports.save"), exact: true }).click();
      await expect
        .poll(async () => db.equipmentModelPort.count({ where: { modelId: model.id } }))
        .toBe(2);
      await page.goto("/inventory/new");
      await page.locator('select[name="mobility"]').selectOption("POOLED");
      await page.locator('select[name="modelId"]').selectOption(model.id);
      await page.locator('input[name="name"]').fill(name);
      await page.locator('input[name="ipAddress"]').fill("192.0.2.25");
      await page
        .getByRole("button", { name: t(locale, "inventory.new.submit"), exact: true })
        .click();
      await expect(page).toHaveURL(/\/inventory\/(?!new)[^/]+$/);
      const unit = await db.equipment.findFirstOrThrow({ where: { name } });
      equipmentIds.push(unit.id);
      const ports = page.getByRole("region", { name: t(locale, "ports.heading") });
      await expect(ports.getByRole("heading", { name: "HDMI OUT", exact: true })).toBeVisible();
      await expect(page.locator('input[name="ipAddress"]')).toHaveValue("192.0.2.25");
      await ports
        .locator("summary")
        .filter({ hasText: t(locale, "ports.add") })
        .click();
      const add = ports.locator("details").last();
      await add.getByRole("textbox", { name: t(locale, "ports.label"), exact: true }).fill("USB-C");
      await add.getByRole("button", { name: t(locale, "common.save"), exact: true }).click();
      await expect(ports.getByRole("heading", { name: "USB-C", exact: true })).toBeVisible();
      await expect(
        add.getByRole("textbox", { name: t(locale, "ports.label"), exact: true }),
      ).toHaveValue("");
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1280);
      page.once("dialog", (dialog) => dialog.accept());
      await ports
        .getByRole("button", {
          name: t(locale, "ports.removePort", { label: "USB-C" }),
          exact: true,
        })
        .click();
      await expect(ports.getByRole("heading", { name: "USB-C", exact: true })).toHaveCount(0);
    });
  }
}
