import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const fieldIds: string[] = [],
  kindIds: string[] = [],
  roomIds: string[] = [];
const renders = "test-results/fields-admin";
test.afterEach(async () => {
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds.splice(0) } } });
  await db.customField.deleteMany({
    where: { OR: [{ id: { in: fieldIds.splice(0) } }, { name: { startsWith: runPrefix() } }] },
  });
  await db.equipmentKind.deleteMany({ where: { id: { in: kindIds.splice(0) } } });
});
test.afterAll(() => db.$disconnect());

async function fixture() {
  const group = await db.equipmentFunctionGroup.findFirstOrThrow({ where: { archivedAt: null } });
  const kind = await db.equipmentKind.create({
    data: { name: `${runPrefix()} Projektoren`, groupId: group.id, position: 50 },
  });
  kindIds.push(kind.id);
  const room = await db.room.create({
    data: { name: `${runPrefix()} Saal`, slug: `${runPrefix()}fields-hall` },
  });
  roomIds.push(room.id);
  const device = await db.equipment.create({
    data: { name: `${runPrefix()} Projektor`, kindId: kind.id, category: "OTHER", roomId: room.id },
  });
  return { kind, room, device };
}
async function createField(page: Page, name: string, type: string, unit?: string) {
  await page.getByRole("button", { name: t("de", "fields.admin.add"), exact: true }).click();
  const panel = page.getByRole("complementary", { name: t("de", "fields.admin.add"), exact: true });
  await panel.getByLabel(t("de", "admin.structure.name"), { exact: true }).fill(name);
  await panel.getByLabel(t("de", "fields.admin.type"), { exact: true }).selectOption(type);
  if (unit) {
    await panel.getByText(t("de", "fields.admin.moreSettings"), { exact: true }).click();
    await panel.getByLabel(t("de", "fields.admin.unit"), { exact: true }).fill(unit);
  }
  await panel.getByRole("button", { name: t("de", "common.save"), exact: true }).click();
  const editor = page.getByRole("complementary", {
    name: t("de", "fields.admin.edit"),
    exact: true,
  });
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel(t("de", "fields.admin.key"), { exact: true })).not.toHaveValue("");
  const field = await db.customField.findFirstOrThrow({ where: { name } });
  fieldIds.push(field.id);
  return { field, editor };
}

test("defines number and choice fields on screen, previews pasted options, and fills a device", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 1000 });
  const { kind, device } = await fixture();
  await page.goto(`/admin/structure?tab=fields&kind=${kind.id}`);
  const numberName = `${runPrefix()} Lampenstunden`,
    choiceName = `${runPrefix()} Bauart`;
  const { field: number, editor } = await createField(page, numberName, "NUMBER", "h");
  await expect(editor.getByLabel(kind.name, { exact: true })).toBeChecked();
  await editor.getByRole("button", { name: t("de", "common.cancel"), exact: true }).click();
  await page.goto("/admin/structure?tab=fields");
  await expect(page.locator(`[data-field-id='${number.id}']`)).toHaveCount(0);
  await expect(
    page.getByText(t("de", "fields.admin.everyKindHint"), { exact: true }),
  ).toBeVisible();
  await page.getByLabel(t("de", "fields.admin.viewKind"), { exact: true }).selectOption(kind.id);
  await expect(page.locator(`[data-field-id='${number.id}']`)).toBeVisible();
  const { field: choice, editor: choiceEditor } = await createField(page, choiceName, "CHOICE");
  await choiceEditor
    .getByRole("button", { name: t("de", "fields.admin.paste"), exact: true })
    .click();
  await choiceEditor
    .getByLabel(t("de", "fields.admin.pasteHelp"), { exact: true })
    .fill("Decke\nBoden\nDECKE\nWand");
  await choiceEditor
    .getByRole("button", { name: t("de", "fields.admin.preview"), exact: true })
    .click();
  await expect(
    choiceEditor.getByText(t("de", "fields.admin.paste.repeat"), { exact: true }),
  ).toHaveCount(1);
  expect(await db.customFieldOption.count({ where: { fieldId: choice.id } })).toBe(0);
  mkdirSync(renders, { recursive: true });
  await choiceEditor
    .getByRole("list", { name: t("de", "fields.admin.preview") })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${renders}/paste-preview.png` });
  await choiceEditor
    .getByRole("button", { name: t("de", "fields.admin.confirmPaste", { count: 3 }), exact: true })
    .click();
  await expect(choiceEditor.locator("li[data-option-id]")).toHaveCount(3);
  const options = await db.customFieldOption.findMany({
    where: { fieldId: choice.id },
    orderBy: { position: "asc" },
  });
  expect(options.map((option) => option.label)).toEqual(["Decke", "Boden", "Wand"]);
  await choiceEditor.getByRole("heading", { name: /Optionen/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${renders}/choice-panel.png` });
  await choiceEditor.getByLabel(t("de", "fields.admin.newOption"), { exact: true }).fill("Decke");
  await choiceEditor
    .getByRole("button", { name: t("de", "fields.admin.addOption"), exact: true })
    .click();
  await expect(
    choiceEditor.getByRole("alert").filter({ hasText: t("de", "fields.admin.optionTaken") }),
  ).toBeVisible();
  await expect(
    choiceEditor.getByLabel(t("de", "fields.admin.newOption"), { exact: true }),
  ).toHaveValue("Decke");
  await choiceEditor.getByLabel(t("de", "fields.admin.newOption"), { exact: true }).fill("Tisch");
  await choiceEditor
    .getByRole("button", { name: t("de", "fields.admin.addOption"), exact: true })
    .click();
  await expect(choiceEditor.locator("li[data-option-id]")).toHaveCount(4);
  page.once("dialog", (dialog) => dialog.accept());
  await choiceEditor
    .locator("li[data-option-id]")
    .filter({ has: page.locator('input[value="Tisch"]') })
    .getByRole("button", { name: t("de", "common.delete"), exact: true })
    .click();
  await expect(choiceEditor.locator("li[data-option-id]")).toHaveCount(3);
  await page.goto(`/inventory/${device.id}`);
  await page.getByLabel(numberName, { exact: true }).fill("7.000");
  await page.getByRole("button", { name: t("de", "inventory.detail.submit"), exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("7000");
  await page.getByLabel(numberName, { exact: true }).fill("7000");
  await page.getByLabel(choiceName, { exact: true }).selectOption(options[1].id);
  await page.getByRole("button", { name: t("de", "inventory.detail.submit"), exact: true }).click();
  await expect(page.locator("[data-field-values]")).toContainText("7.000 h");
  await expect(page.locator("[data-field-values]")).toContainText("Boden");
  expect(
    (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).customValues,
  ).toMatchObject({ [number.id]: 7000, [choice.id]: options[1].id });
});

test("archives and restores fields, offers an archived name, and reuses a field for another kind", async ({
  page,
}) => {
  const { kind } = await fixture();
  await page.goto(`/admin/structure?tab=fields&kind=${kind.id}`);
  const name = `${runPrefix()} Kennung`;
  const { field, editor } = await createField(page, name, "TEXT");
  await editor
    .getByRole("button", { name: t("de", "admin.structure.archive"), exact: true })
    .click();
  await expect(page.locator(`[data-field-id='${field.id}']`)).toHaveCount(0);
  await editor.getByRole("button", { name: t("de", "common.cancel"), exact: true }).click();
  await page.getByRole("button", { name: t("de", "fields.admin.add"), exact: true }).click();
  const panel = page.getByRole("complementary", { name: t("de", "fields.admin.add"), exact: true });
  await panel.getByLabel(t("de", "admin.structure.name"), { exact: true }).fill("   ");
  await panel.getByRole("button", { name: t("de", "common.save"), exact: true }).click();
  await expect(panel.locator("#field-name-error")).toHaveText(t("de", "fields.admin.labelInvalid"));
  await panel.getByLabel(t("de", "admin.structure.name"), { exact: true }).fill(name);
  await expect(
    panel.getByRole("button", { name: t("de", "fields.admin.restoreExisting"), exact: true }),
  ).toBeVisible();
  await panel
    .getByRole("button", { name: t("de", "fields.admin.restoreExisting"), exact: true })
    .click();
  await expect(page.locator(`[data-field-id='${field.id}']`)).toBeVisible();
  expect(await db.customField.count({ where: { name } })).toBe(1);
  await editor
    .getByRole("button", { name: t("de", "admin.structure.archive"), exact: true })
    .click();
  await page.locator('label[for="show-archived"]').click();
  await expect(page.locator(`[data-field-id='${field.id}']`)).toBeVisible();
  await editor
    .getByRole("button", { name: t("de", "admin.structure.restore"), exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: t("de", "admin.structure.archive"), exact: true }),
  ).toBeVisible();
  const target = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  await page.goto(`/admin/structure?tab=fields&kind=${target.id}`);
  await page.getByRole("button", { name: t("de", "fields.admin.add"), exact: true }).click();
  await panel.getByLabel(t("de", "admin.structure.name"), { exact: true }).fill(name);
  await panel.getByRole("button", { name: t("de", "fields.admin.reuse"), exact: true }).click();
  await expect(page.locator(`[data-field-id='${field.id}']`)).toBeVisible();
  expect(await db.customFieldKind.count({ where: { fieldId: field.id } })).toBe(2);
  await editor
    .getByRole("button", { name: t("de", "admin.structure.archive"), exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: t("de", "common.delete"), exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await editor.getByRole("button", { name: t("de", "common.delete"), exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(await db.customField.count({ where: { id: field.id } })).toBe(0);
});

test("names the fields that follow an archived kind and preserves their values", async ({
  page,
}) => {
  const { kind, device } = await fixture();
  const field = await db.customField.create({
    data: {
      scope: "EQUIPMENT",
      key: `f_${device.id}`,
      name: "Betriebsdauer",
      type: "NUMBER",
      unit: "h",
      kinds: { create: { kindId: kind.id } },
    },
  });
  fieldIds.push(field.id);
  await db.equipment.update({
    where: { id: device.id },
    data: { customValues: { [field.id]: 42 } },
  });
  await page.goto("/admin/structure");
  await page
    .locator(`[data-entry-id='${kind.id}']`)
    .getByRole("button", { name: t("de", "admin.structure.archive"), exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(field.name);
  await expect(dialog).toContainText(t("de", "admin.structure.fieldsMove"));
  mkdirSync(renders, { recursive: true });
  await page.screenshot({ path: `${renders}/archive-kind.png` });
  const target = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  await dialog
    .getByLabel(t("de", "admin.structure.moveTo"), { exact: true })
    .selectOption(target.id);
  await dialog
    .getByRole("button", { name: t("de", "admin.structure.archiveAndMove"), exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.goto(`/inventory/${device.id}`);
  await expect(page.getByLabel(field.name, { exact: true })).toHaveValue("42");
});

test("forty fields and fifty options fit both widths, languages and densities", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { kind } = await fixture();
  const rows = [];
  for (let index = 0; index < 40; index++) {
    const field = await db.customField.create({
      data: {
        scope: "EQUIPMENT",
        key: `f_${kind.id}_${index}`.slice(0, 40),
        name:
          index === 0
            ? "Betriebsmodus"
            : `Angabe ${index + 1} mit einer langen verständlichen Bezeichnung`,
        type: index === 0 ? "CHOICE" : "TEXT",
        section: index < 10 ? "Betrieb" : index < 25 ? "Dokumentation" : null,
        position: index,
        kinds: { create: { kindId: kind.id } },
        options:
          index === 0
            ? {
                create: Array.from({ length: 50 }, (_, n) => ({
                  label: `Option ${n + 1}`,
                  position: n,
                })),
              }
            : undefined,
      },
    });
    fieldIds.push(field.id);
    rows.push(field);
  }
  mkdirSync(renders, { recursive: true });
  for (const width of [1280, 1920])
    for (const locale of ["de", "en"] as const)
      for (const density of ["comfortable", "compact"]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.context().addCookies([
          { name: "locale", value: locale, url: baseURL! },
          { name: "density", value: density, url: baseURL! },
          { name: "view", value: "desktop", url: baseURL! },
        ]);
        await page.goto(`/admin/structure?tab=fields&kind=${kind.id}`);
        await expect(page.locator("li[data-field-id]")).toHaveCount(40);
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect(
          page.getByRole("heading", { name: t(locale, "admin.structure.title"), exact: true }),
        ).toBeVisible();
        await expect(page.locator("aside").first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({ path: `${renders}/tab-${width}-${locale}-${density}.png` });
        await page.locator(`[data-field-id='${rows[0].id}']`).locator("button").first().click();
        const panel = page.getByRole("complementary", {
          name: t(locale, "fields.admin.edit"),
          exact: true,
        });
        await expect(panel.locator("li[data-option-id]")).toHaveCount(50);
        await panel
          .getByRole("heading", { name: new RegExp(t(locale, "fields.admin.options")) })
          .scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({ path: `${renders}/panel-${width}-${locale}-${density}.png` });
      }
});
