import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const renders = "test-results/structure";
const prefix = () => `${runPrefix()}s-`;
test.afterEach(async () => {
  await db.equipment.deleteMany({ where: { name: { startsWith: prefix() } } });
  await db.equipmentModel.deleteMany({ where: { name: { startsWith: prefix() } } });
  await db.room.deleteMany({ where: { name: { startsWith: prefix() } } });
  await db.equipmentKind.deleteMany({ where: { name: { startsWith: prefix() } } });
  await db.equipmentFunctionGroup.deleteMany({ where: { name: { startsWith: prefix() } } });
});
test.afterAll(() => db.$disconnect());

async function addKind(page: Page) {
  await page.goto("/admin/structure");
  await page.getByRole("button", { name: t("de", "admin.structure.addKind"), exact: true }).click();
  await page.getByLabel(t("de", "admin.structure.name"), { exact: true }).fill(`${prefix()}Kind`);
  await page.getByRole("button", { name: t("de", "common.save"), exact: true }).click();
  await expect(page.getByText(`${prefix()}Kind`, { exact: true })).toBeVisible();
  return db.equipmentKind.findFirstOrThrow({ where: { name: `${prefix()}Kind` } });
}

test("add a kind, see it in a device form, rename it on the hall page, then archive with a move", async ({
  page,
}) => {
  const kind = await addKind(page);
  await page.goto("/inventory/new");
  await expect(
    page
      .getByLabel(t("de", "inventory.kind"), { exact: true })
      .locator(`option[value='${kind.id}']`),
  ).toHaveText(kind.name);
  const room = await db.room.create({ data: { name: `${prefix()}Hall`, slug: `${prefix()}hall` } });
  const device = await db.equipment.create({
    data: { name: `${prefix()}Device`, category: "OTHER", kindId: kind.id, roomId: room.id },
  });
  const model = await db.equipmentModel.create({
    data: { name: `${prefix()}Model`, category: "OTHER", kindId: kind.id },
  });
  await page.goto("/admin/structure");
  const row = page.locator(`[data-entry-id='${kind.id}']`);
  await row.getByRole("button", { name: t("de", "admin.structure.edit") }).click();
  await row.getByLabel(t("de", "admin.structure.name"), { exact: true }).fill(`${prefix()}Renamed`);
  await row.getByRole("button", { name: t("de", "common.save"), exact: true }).click();
  await expect(row.getByText(`${prefix()}Renamed`, { exact: true })).toBeVisible();
  await page.goto(`/rooms/${room.slug}`);
  await expect(page.getByText(`${prefix()}Renamed`, { exact: true })).toBeVisible();
  await page.goto("/admin/structure");
  await row.getByRole("button", { name: t("de", "admin.structure.archive"), exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const target = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "other" } });
  await dialog
    .getByLabel(t("de", "admin.structure.moveTo"), { exact: true })
    .selectOption(target.id);
  await dialog
    .getByRole("button", { name: t("de", "admin.structure.archiveAndMove"), exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(row).toHaveCount(0);
  await expect
    .poll(async () => (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).kindId)
    .toBe(target.id);
  expect((await db.equipmentModel.findUniqueOrThrow({ where: { id: model.id } })).kindId).toBe(
    target.id,
  );
  await page.getByLabel(t("de", "admin.structure.showArchived"), { exact: true }).check();
  await row.getByRole("button", { name: t("de", "admin.structure.restore"), exact: true }).click();
  await expect(row.getByText(t("de", "admin.structure.archived"), { exact: true })).toHaveCount(0);
});

test("structure states fit both widths, languages and densities", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  mkdirSync(renders, { recursive: true });
  const group = await db.equipmentFunctionGroup.create({
    data: { name: `${prefix()}Lange Funktionsgruppe für Veranstaltungen`, position: 0 },
  });
  const activeCount = await db.equipmentKind.count({ where: { archivedAt: null } });
  await db.equipmentKind.createMany({
    data: Array.from({ length: 80 - activeCount }, (_, index) => ({
      name: `${prefix()}${String(index).padStart(2, "0")} Lange Geräteart für Veranstaltungen`,
      groupId: group.id,
      position: index,
    })),
  });
  const archived = await db.equipmentKind.create({
    data: { name: `${prefix()}Archived`, groupId: group.id, archivedAt: new Date(), position: 81 },
  });
  for (const width of [1280, 1920])
    for (const locale of ["de", "en"] as const)
      for (const density of ["comfortable", "compact"]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.context().addCookies([
          { name: "locale", value: locale, url: baseURL! },
          { name: "density", value: density, url: baseURL! },
          { name: "view", value: "desktop", url: baseURL! },
        ]);
        for (const tab of ["kinds", "groups"]) {
          await page.goto(`/admin/structure?tab=${tab}`);
          await expect(
            page.getByRole("heading", { name: t(locale, "admin.structure.title"), exact: true }),
          ).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.screenshot({
            path: `${renders}/${tab}-${width}-${locale}-${density}.png`,
            fullPage: true,
          });
          await page.getByLabel(t(locale, "admin.structure.showArchived"), { exact: true }).check();
          if (tab === "kinds")
            await expect(page.locator(`[data-entry-id='${archived.id}']`)).toBeVisible();
          await page.screenshot({
            path: `${renders}/${tab}-archived-${width}-${locale}-${density}.png`,
            fullPage: true,
          });
          await page
            .getByRole("button", {
              name: t(
                locale,
                tab === "kinds" ? "admin.structure.addKind" : "admin.structure.addGroup",
              ),
              exact: true,
            })
            .click();
          await expect(
            page.getByLabel(t(locale, "admin.structure.name"), { exact: true }),
          ).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.screenshot({
            path: `${renders}/${tab}-adding-${width}-${locale}-${density}.png`,
            fullPage: true,
          });
        }
      }
});
