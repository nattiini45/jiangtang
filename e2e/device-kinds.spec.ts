import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";
import { reconcileLibrary } from "~/lib/custom-fields/library.server";

const rooms: string[] = [];
const models: string[] = [];
const renders = "test-results/device-kinds";

test.afterEach(async () => {
  await db.equipment.deleteMany({ where: { roomId: { in: rooms } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: models } } });
  await db.room.deleteMany({ where: { id: { in: rooms } } });
  rooms.length = 0;
  models.length = 0;
});

test.afterAll(() => db.$disconnect());

test("edits preserve an archived kind or group and its category-specific fields", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const computer = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "computer" } });
  const room = await db.room.create({
    data: { name: `${runPrefix()}Archived kind hall`, slug: `${runPrefix()}archived-kind` },
  });
  rooms.push(room.id);
  const model = await db.equipmentModel.create({
    data: { name: `${runPrefix()}Archived kind model`, category: "PC", kindId: computer.id },
  });
  models.push(model.id);
  const device = await db.equipment.create({
    data: {
      roomId: room.id,
      modelId: model.id,
      name: `${runPrefix()}Archived kind device`,
      category: "PC",
      kindId: computer.id,
      dellServiceTag: "DEMO123",
      dellExpressTag: "123456",
    },
  });
  await reconcileLibrary();
  const service = await db.customField.findUniqueOrThrow({ where: { systemKey: "service_code" } });
  await page.context().addCookies([
    { name: "locale", value: "de", url: baseURL! },
    { name: "view", value: "desktop", url: baseURL! },
  ]);
  for (const target of ["kind", "group"]) {
    try {
      if (target === "kind")
        await db.equipmentKind.update({
          where: { id: computer.id },
          data: { archivedAt: new Date("2040-01-01T00:00:00Z") },
        });
      else
        await db.equipmentFunctionGroup.update({
          where: { id: computer.groupId },
          data: { archivedAt: new Date("2040-01-01T00:00:00Z") },
        });
      await page.goto(`/inventory/${device.id}`);
      await expect(page.getByLabel(t("de", "inventory.kind"), { exact: true })).toHaveValue(
        computer.id,
      );
      await expect(page.locator(`input[id='cf.${service.id}']`)).toHaveValue("DEMO123");
      const updatedName = `${runPrefix()}Preserved archived ${target}`;
      await page.getByLabel(t("de", "inventory.form.name"), { exact: true }).fill(updatedName);
      await page
        .getByRole("button", { name: t("de", "inventory.detail.submit"), exact: true })
        .click();
      await expect(page.locator(`input[id='cf.${service.id}']`)).toHaveValue("DEMO123");
      await expect
        .poll(async () => (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).name)
        .toBe(updatedName);
      expect(await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).toMatchObject({
        kindId: computer.id,
        category: "PC",
        dellServiceTag: "DEMO123",
        dellExpressTag: "123456",
      });
      await page.goto(`/inventory/models/${model.id}`);
      await page.getByText(t("de", "inventory.models.editSummary"), { exact: true }).click();
      await expect(page.getByLabel(t("de", "inventory.kind"), { exact: true })).toHaveValue(
        computer.id,
      );
      await page
        .getByLabel(t("de", "inventory.models.specNotes"), { exact: true })
        .fill(`Synthetic ${target} edit`);
      await page
        .getByRole("button", { name: t("de", "inventory.models.submit"), exact: true })
        .click();
      await expect(
        page.getByText(t("de", "inventory.models.saved"), { exact: true }),
      ).toBeVisible();
      expect(await db.equipmentModel.findUniqueOrThrow({ where: { id: model.id } })).toMatchObject({
        kindId: computer.id,
        category: "PC",
        specNotes: `Synthetic ${target} edit`,
      });
      for (const path of ["/inventory/new", "/inventory/models/new", "/inventory"]) {
        await page.goto(path);
        await expect(
          page.locator(`select[name='kindId'] option[value='${computer.id}']`),
        ).toHaveCount(0);
      }
    } finally {
      await db.equipmentKind.update({
        where: { id: computer.id },
        data: { archivedAt: computer.archivedAt },
      });
      await db.equipmentFunctionGroup.update({
        where: { id: computer.groupId },
        data: { archivedAt: null },
      });
    }
  }
});

async function checkWidth(page: Page) {
  expect(
    await page
      .locator("main")
      .evaluate((element) =>
        [...element.querySelectorAll("*")]
          .filter((child) => getComputedStyle(child).overflowX === "auto")
          .every((child) => child.scrollWidth <= child.clientWidth),
      ),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator("aside").first()).toBeVisible();
}

for (const locale of ["de", "en"] as const) {
  for (const density of ["comfortable", "compact"] as const) {
    test(`device kinds in ${locale} ${density}`, async ({ page, baseURL }) => {
      test.setTimeout(180_000);
      mkdirSync(renders, { recursive: true });
      const prefix = `${runPrefix()}kinds-${locale}-${density}`;
      const room = await db.room.create({
        data: { name: "Demo-Saal · 30 Geräte", slug: prefix },
      });
      rooms.push(room.id);
      const kinds = await db.equipmentKind.findMany({
        include: { group: true },
        orderBy: [{ group: { position: "asc" } }, { name: "asc" }],
      });
      const microphone = kinds.find((kind) => kind.systemKey === "microphone")!;
      const model = await db.equipmentModel.create({
        data: { name: "Demo-Mikrofonmodell", category: "MICROPHONE", kindId: microphone.id },
      });
      models.push(model.id);
      const categories = ["PROJECTOR", "SMARTBOARD", "PC", "MICROPHONE", "MEDIA_CONTROL"] as const;
      const keys = [
        "projector",
        "interactive_display",
        "computer",
        "microphone",
        "control_processor",
      ];
      const devices = await Promise.all(
        Array.from({ length: 30 }, (_, index) => {
          const kind = kinds.find((kind) => kind.systemKey === keys[index % keys.length])!;
          return db.equipment.create({
            data: {
              roomId: room.id,
              name:
                index === 3
                  ? null
                  : `${kind.name} ${String(index + 1).padStart(2, "0")} · Demo-Gerät mit langer Einbaubezeichnung`,
              category: categories[index % categories.length],
              kindId: kind.id,
              modelId: index === 3 ? model.id : undefined,
              status: index === 0 ? "FAULTY" : "OPERATIONAL",
            },
          });
        }),
      );
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);

      for (const width of [1280, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/rooms/${room.slug}`);
        await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
        const installed = page
          .getByRole("heading", { name: t(locale, "rooms.dashboard.installed"), exact: true })
          .locator("../..");
        const shownGroups = kinds
          .filter((kind) => keys.includes(kind.systemKey!))
          .map((kind) => kind.group);
        const uniqueGroups = [...new Map(shownGroups.map((group) => [group.id, group])).values()];
        await expect(installed.getByRole("heading", { level: 3 })).toHaveText(
          uniqueGroups.map((group) => group.name),
        );
        await expect(installed.locator("li")).toHaveCount(30);
        for (const group of uniqueGroups) {
          const section = installed.getByRole("region", { name: group.name, exact: true });
          const expected = devices
            .filter(
              (device) => kinds.find((kind) => kind.id === device.kindId)!.groupId === group.id,
            )
            .sort(
              (a, b) =>
                kinds
                  .find((kind) => kind.id === a.kindId)!
                  .name.localeCompare(kinds.find((kind) => kind.id === b.kindId)!.name, locale) ||
                (a.name ?? model.name).localeCompare(b.name ?? model.name, locale),
            );
          await expect(section.locator("li a")).toHaveText(
            expected.map((device) => device.name ?? model.name),
          );
          await expect(section.locator("li .text-muted-foreground")).toHaveText(
            expected.map((device) => kinds.find((kind) => kind.id === device.kindId)!.name),
          );
        }
        await checkWidth(page);
        await page.screenshot({
          path: `${renders}/${locale}-${density}-${width}-hall.png`,
          fullPage: true,
        });

        await page.goto(`/inventory/new?roomId=${room.id}`);
        const select = page.getByLabel(t(locale, "inventory.kind"), { exact: true });
        await expect(select.locator("option")).toHaveCount(10);
        expect(
          await select
            .locator("optgroup")
            .evaluateAll((groups) => groups.map((group) => group.getAttribute("label"))),
        ).toEqual([...new Map(kinds.map((kind) => [kind.group.id, kind.group.name])).values()]);
        for (const [key, field] of [
          ["computer", "service_code"],
          ["microphone", "frequency"],
          ["projector", "lampType"],
        ]) {
          await select.selectOption(kinds.find((kind) => kind.systemKey === key)!.id);
          const definition =
            field === "lampType"
              ? null
              : await db.customField.findUniqueOrThrow({ where: { systemKey: field } });
          const input = page.locator(
            definition ? `input[id='cf.${definition.id}']` : `[name='${field}']`,
          );
          await expect(input).toBeAttached();
          if (!(await input.isVisible()))
            await page.locator("details").filter({ has: input }).locator("summary").first().click();
          await expect(input).toBeVisible();
        }
        await select.selectOption(microphone.id);
        await checkWidth(page);
        await page.screenshot({
          path: `${renders}/${locale}-${density}-${width}-device-form.png`,
          fullPage: true,
        });
      }

      const createdName = "Demo-Handmikrofon · Saal";
      await page.getByLabel(t(locale, "inventory.form.name"), { exact: true }).fill(createdName);
      await page
        .getByRole("button", { name: t(locale, "inventory.new.submit"), exact: true })
        .click();
      await expect(page.getByRole("heading", { name: createdName, exact: true })).toBeVisible();
      const created = await db.equipment.findFirstOrThrow({ where: { name: createdName } });
      expect(created).toMatchObject({
        kindId: microphone.id,
        category: "MICROPHONE",
        roomId: room.id,
      });

      for (const width of [1280, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/inventory/${created.id}`);
        await expect(page.getByLabel(t(locale, "inventory.kind"), { exact: true })).toHaveValue(
          microphone.id,
        );
        await checkWidth(page);
        await page.screenshot({
          path: `${renders}/${locale}-${density}-${width}-device-detail.png`,
          fullPage: true,
        });
        await page.goto("/inventory");
        await page
          .getByRole("combobox", { name: t(locale, "inventory.list.filterKind") })
          .selectOption(microphone.id);
        await expect(page).toHaveURL(new RegExp(`kindId=${microphone.id}`));
        await page
          .getByRole("textbox", { name: t(locale, "common.dataGrid.filterLabel") })
          .fill(microphone.name);
        await expect(page.getByRole("link", { name: createdName, exact: true })).toBeVisible();
        await expect(page.locator(`a[href='/inventory/${devices[0].id}']`)).toHaveCount(0);
        const longName = page.locator(`a[href='/inventory/${devices[8].id}']`);
        await expect
          .poll(() => longName.evaluate((element) => getComputedStyle(element).textOverflow))
          .toBe("ellipsis");
        await checkWidth(page);
        await page.screenshot({ path: `${renders}/${locale}-${density}-${width}-device-list.png` });
        await page.goto("/inventory?category=MICROPHONE");
        await expect(
          page.getByRole("combobox", { name: t(locale, "inventory.list.filterKind") }),
        ).toHaveValue(microphone.id);
        await expect(page.locator(`a[href='/inventory/${devices[0].id}']`)).toHaveCount(0);
        await page.goto("/inventory?tab=models");
        await page
          .getByRole("textbox", { name: t(locale, "common.dataGrid.filterLabel") })
          .fill(microphone.name);
        await expect(page.getByRole("link", { name: model.name, exact: true })).toBeVisible();
        await checkWidth(page);
        await page.screenshot({ path: `${renders}/${locale}-${density}-${width}-model-list.png` });
        await page.goto(`/inventory/models/${model.id}`);
        await page.getByText(t(locale, "inventory.models.editSummary"), { exact: true }).click();
        await expect(page.getByLabel(t(locale, "inventory.kind"), { exact: true })).toHaveValue(
          microphone.id,
        );
        await checkWidth(page);
        await page.screenshot({
          path: `${renders}/${locale}-${density}-${width}-model-detail.png`,
          fullPage: true,
        });
        await page.goto("/inventory/models/new");
        await page
          .getByLabel(t(locale, "inventory.kind"), { exact: true })
          .selectOption(microphone.id);
        await checkWidth(page);
        await page.screenshot({
          path: `${renders}/${locale}-${density}-${width}-model-form.png`,
          fullPage: true,
        });
      }
      await page
        .getByLabel(t(locale, "inventory.models.name"), { exact: true })
        .fill("Demo-Mikrofonmodell · neu");
      await page
        .getByRole("button", { name: t(locale, "inventory.models.createSubmit"), exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Demo-Mikrofonmodell · neu", exact: true }),
      ).toBeVisible();
      const createdModel = await db.equipmentModel.findFirstOrThrow({
        where: { name: "Demo-Mikrofonmodell · neu" },
      });
      models.push(createdModel.id);
      expect(createdModel).toMatchObject({ category: "MICROPHONE", kindId: microphone.id });
    });
  }
}
