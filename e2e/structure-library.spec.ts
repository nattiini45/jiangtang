import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const installed: string[] = [];
const addedGroups: string[] = [];
const prefix = () => `${runPrefix()}lib-`;
const renders = "test-results/structure-library";
test.afterEach(async () => {
  await db.equipment.deleteMany({ where: { name: { startsWith: prefix() } } });
  const owned = await db.equipmentKind.findMany({
    where: { OR: [{ id: { in: installed } }, { name: { startsWith: prefix() } }] },
    select: { id: true },
  });
  const links = await db.customFieldKind.findMany({
    where: { kindId: { in: owned.map((kind) => kind.id) } },
  });
  await db.customFieldKind.deleteMany({ where: { kindId: { in: owned.map((kind) => kind.id) } } });
  await db.customField.deleteMany({
    where: { id: { in: links.map((link) => link.fieldId) }, kinds: { none: {} } },
  });
  await db.equipmentKind.deleteMany({
    where: { OR: [{ id: { in: installed } }, { name: { startsWith: prefix() } }] },
  });
  await db.equipmentFunctionGroup.deleteMany({ where: { id: { in: addedGroups } } });
  installed.length = 0;
  addedGroups.length = 0;
});
test.afterAll(() => db.$disconnect());

test("installs exactly two library kinds and immediately offers them on device and model forms", async ({
  page,
}) => {
  await page.goto("/admin/structure");
  await page
    .getByRole("button", { name: t("de", "admin.structure.library.add"), exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel(t("de", "admin.structure.library.institution"), { exact: true })
    .selectOption("university");
  const selected = dialog.locator('input[name="keys"]:checked');
  while (await selected.count()) await selected.first().uncheck();
  for (const key of ["extender", "avoip_encoder"])
    await dialog.locator(`input[value='${key}']`).check();
  await dialog
    .getByRole("button", {
      name: t("de", "admin.structure.library.install", { count: 2 }),
      exact: true,
    })
    .click();
  await expect(dialog).not.toBeVisible();
  const kinds = await db.equipmentKind.findMany({
    where: { systemKey: { in: ["extender", "avoip_encoder"] } },
  });
  installed.push(...kinds.map((kind) => kind.id));
  addedGroups.push(kinds[0].groupId);
  expect(kinds).toHaveLength(2);
  for (const path of ["/inventory/new", "/inventory/models/new"]) {
    await page.goto(path);
    for (const kind of kinds)
      await expect(
        page
          .getByLabel(t("de", "inventory.kind"), { exact: true })
          .locator(`option[value='${kind.id}']`),
      ).toHaveText(kind.name);
  }
});

test("library, editing, error and archive states fit both widths, languages and densities", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  mkdirSync(renders, { recursive: true });
  const group = await db.equipmentFunctionGroup.findUniqueOrThrow({
    where: { systemKey: "display" },
  });
  const kind = await db.equipmentKind.create({
    data: {
      name: `${prefix()}Installation device kind with a long label`,
      groupId: group.id,
      position: 99,
    },
  });
  const taken = await db.equipmentKind.create({
    data: { name: "Display (Monitor)", groupId: group.id, position: 100 },
  });
  const archived = await db.equipmentKind.create({
    data: {
      name: `${prefix()}Old LED label`,
      systemKey: "led_wall",
      groupId: group.id,
      position: 101,
      archivedAt: new Date(),
    },
  });
  installed.push(kind.id, taken.id, archived.id);
  await db.equipment.create({
    data: { name: `${prefix()}Device`, category: "OTHER", kindId: kind.id, mobility: "POOLED" },
  });
  for (const width of [1280, 1920])
    for (const locale of ["de", "en"] as const)
      for (const density of ["comfortable", "compact"]) {
        await page.context().addCookies([
          { name: "locale", value: locale, url: baseURL! },
          { name: "density", value: density, url: baseURL! },
          { name: "view", value: "desktop", url: baseURL! },
        ]);
        await page.setViewportSize({ width, height: 1000 });
        const capture = async (name: string) => {
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.screenshot({
            path: `${renders}/${name}-${width}-${locale}-${density}.png`,
            fullPage: true,
          });
        };
        await page.goto("/admin/structure");
        await expect(
          page.getByRole("heading", { name: t(locale, "admin.structure.title"), exact: true }),
        ).toBeVisible();
        await capture("kinds");
        const row = page.locator(`[data-entry-id='${kind.id}']`);
        await row.getByRole("button", { name: t(locale, "admin.structure.edit") }).click();
        await expect(
          row.getByLabel(t(locale, "admin.structure.name"), { exact: true }),
        ).toBeVisible();
        await capture("editing");
        await row.getByLabel(t(locale, "admin.structure.name"), { exact: true }).fill("PC");
        await row.getByRole("button", { name: t(locale, "common.save"), exact: true }).click();
        await expect(row.getByRole("alert")).toContainText(t(locale, "admin.structure.nameTaken"));
        await capture("error");
        await page.goto("/admin/structure");
        await row
          .getByRole("button", { name: t(locale, "admin.structure.archive"), exact: true })
          .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await capture("archive");
        await page
          .getByRole("dialog")
          .getByRole("button", { name: t(locale, "common.cancel"), exact: true })
          .click();
        await page
          .getByRole("link", { name: t(locale, "admin.structure.groups"), exact: true })
          .click();
        await expect(
          page.getByRole("link", { name: t(locale, "admin.structure.groups"), exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await capture("groups");
        await page
          .getByRole("link", { name: t(locale, "admin.structure.kinds"), exact: true })
          .click();
        await expect(
          page.getByRole("link", { name: t(locale, "admin.structure.kinds"), exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await page
          .getByRole("button", { name: t(locale, "admin.structure.library.add"), exact: true })
          .click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();
        await capture("library-start");
        await dialog
          .getByLabel(t(locale, "admin.structure.library.institution"), { exact: true })
          .selectOption("university");
        await expect(dialog.locator('input[value="projector"]')).toBeDisabled();
        await expect(dialog.locator('input[value="display"]')).toBeDisabled();
        await expect(dialog.locator('input[value="led_wall"]')).toBeDisabled();
        await expect(
          dialog.getByText(t(locale, "admin.structure.library.installedAs", { name: "PC" }), {
            exact: true,
          }),
        ).toBeVisible();
        await capture("library");
        await dialog.getByRole("button", { name: t(locale, "common.cancel"), exact: true }).click();
      }
});
