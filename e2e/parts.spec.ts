import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { linkCatalogModel } from "~/domains/catalog/catalog.library.server";
import { addPartStock } from "~/domains/inventory/inventory.parts.mutations.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

test.describe.configure({ mode: "serial" });
let hostId: string, lampHostId: string, filterId: string, roomId: string;
let baselineModels: string[];
const deviceIds: string[] = [],
  stockIds: string[] = [];
const renders = "test-results/parts";
test.beforeAll(async () => {
  baselineModels = (await db.equipmentModel.findMany({ select: { id: true } })).map(
    (model) => model.id,
  );
  const actor = await db.user.findFirstOrThrow({ where: { role: "ADMIN", isActive: true } });
  const host = await linkCatalogModel(actor, "epson-eb-l1750u");
  hostId = host.id;
  lampHostId = (await linkCatalogModel(actor, "epson-eb-g7200w")).id;
  filterId = (await db.equipmentModel.findUniqueOrThrow({ where: { catalogKey: "epson-elpaf51" } }))
    .id;
  const room = await db.room.create({
    data: { name: "Synthetic hall 33", slug: `${runPrefix()}parts-hall-33` },
  });
  roomId = room.id;
  for (let index = 0; index < 16; index++) {
    const device = await db.equipment.create({
      data: {
        name:
          index === 0
            ? "Synthetic laser projector 33"
            : `Synthetic projector ${index + 1} with an intentionally long descriptive name`,
        category: "PROJECTOR",
        kindId: host.kindId,
        modelId: hostId,
        roomId,
      },
    });
    deviceIds.push(device.id);
  }
  mkdirSync(renders, { recursive: true });
});
test.afterEach(async () => {
  await db.inventoryItem.deleteMany({ where: { id: { in: stockIds.splice(0) } } });
});
test.afterAll(async () => {
  await db.equipment.deleteMany({ where: { id: { in: deviceIds } } });
  await db.room.delete({ where: { id: roomId } });
  const newModels = { id: { notIn: baselineModels } };
  await db.modelPartFit.deleteMany({ where: { model: newModels } });
  await db.equipmentModel.deleteMany({ where: newModels });
  await db.$disconnect();
});

for (const locale of ["de", "en"] as const)
  for (const density of ["comfortable", "compact"] as const)
    test(`a laser projector knows its filter and taking one updates stock in ${locale} ${density}`, async ({
      page,
      baseURL,
    }) => {
      const actor = await db.user.findFirstOrThrow({ where: { role: "ADMIN", isActive: true } });
      const stock = await addPartStock(actor, filterId, 2);
      stockIds.push(stock.id);
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);
      await page.setViewportSize({ width: 1280, height: 1000 });
      const capture = async (name: string) => {
        await expect(page.locator("aside").first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({ path: `${renders}/${name}-${locale}-${density}.png` });
      };
      await page.goto(`/inventory/${deviceIds[0]}`);
      const panel = page.getByRole("region", { name: t(locale, "parts.heading"), exact: true });
      await expect(panel).toContainText("ELPAF51");
      await expect(panel).toContainText(t(locale, "parts.count", { count: 2 }));
      await expect(panel.getByRole("link", { name: t(locale, "parts.source") })).toHaveAttribute(
        "href",
        /epson\.eu/,
      );
      await expect(panel).not.toContainText("ELPLP");
      await expect(
        page.locator("[data-field-values]").getByText("Laser", { exact: true }),
      ).toBeVisible();
      await capture("device");
      await panel.getByRole("link", { name: "Epson ELPAF51", exact: true }).click();
      const detail = page.getByRole("region", {
        name: t(locale, "parts.stockAndFits"),
        exact: true,
      });
      await expect(
        detail.getByRole("link", { name: "Epson EB-L1750U", exact: true }),
      ).toBeVisible();
      for (const id of deviceIds)
        await expect(detail.locator(`a[href='/inventory/${id}']`)).toHaveCount(1);
      const agent = await page.evaluate(async (modulePath) => {
        const { uiAgent } = await import(modulePath);
        const entries: { offPage?: boolean; component: string; label: string }[] = uiAgent
          .snapshot()
          .filter(
            (entry: { offPage?: boolean; component: string }) =>
              !entry.offPage && ["input", "button"].includes(entry.component),
          );
        return {
          labels: entries.map((entry) => entry.label),
          result: await uiAgent.act({
            steps: [
              {
                ref:
                  document.documentElement.lang === "de"
                    ? "Eingegangene Menge"
                    : "Quantity received",
                action: "setValue",
                args: ["1"],
              },
            ],
          }),
        };
      }, "/app/lib/ui-agent.client.ts");
      expect(agent.labels).toContain(t(locale, "parts.addStock"));
      expect(agent.result.ok).toBe(true);
      expect(
        await detail
          .getByRole("spinbutton")
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBe(density === "compact" ? 28 : 36);
      await detail.getByRole("button", { name: t(locale, "parts.addStock"), exact: true }).click();
      await expect(detail).toContainText(t(locale, "parts.count", { count: 3 }));
      await expect(
        detail.getByRole("button", { name: t(locale, "parts.addStock"), exact: true }),
      ).toBeEnabled();
      const added = await db.inventoryItem.findMany({
        where: { modelId: filterId, id: { not: stock.id } },
      });
      stockIds.push(...added.map((row) => row.id));
      await capture("part");
      await page.setViewportSize({ width: 1920, height: 1080 });
      await capture("part-wide");
      const widths = await detail
        .locator("tbody th")
        .first()
        .evaluate((element) => {
          const link = element.querySelector("a")!;
          return {
            width: element.getBoundingClientRect().width,
            overflow: getComputedStyle(link).textOverflow,
          };
        });
      expect(widths.width).toBeGreaterThan(450);
      expect(widths.overflow).toBe("ellipsis");
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto(`/inventory/stock/${stock.id}`);
      const stockModel = page.getByRole("form", {
        name: t(locale, "parts.stockModel"),
        exact: true,
      });
      await expect
        .poll(() =>
          page.evaluate(async (modulePath) => {
            const { uiAgent } = await import(modulePath);
            return uiAgent.act({
              steps: [
                {
                  ref: document.documentElement.lang === "de" ? "Teilemodell" : "Part model",
                  action: "setValue",
                  args: ["none"],
                },
              ],
            });
          }, "/app/lib/ui-agent.client.ts"),
        )
        .toMatchObject({ ok: true });
      await expect(stockModel.getByRole("combobox")).toHaveText(t(locale, "parts.noModel"));
      await stockModel
        .getByRole("button", { name: t(locale, "parts.stockModel"), exact: true })
        .click();
      await expect(stockModel.getByRole("status")).toHaveText(t(locale, "parts.saved"));
      expect(
        (await db.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } })).modelId,
      ).toBeNull();
      await stockModel.getByRole("combobox").click();
      await page.getByRole("option", { name: "Epson ELPAF51", exact: true }).click();
      await stockModel
        .getByRole("button", { name: t(locale, "parts.stockModel"), exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await db.inventoryItem.findUniqueOrThrow({ where: { id: stock.id } })).modelId,
        )
        .toBe(filterId);
      await expect(
        stockModel.getByRole("button", { name: t(locale, "parts.stockModel"), exact: true }),
      ).toBeEnabled();
      await expect(page.getByRole("link", { name: "Epson ELPAF51", exact: true })).toBeVisible();
      expect(
        await stockModel
          .getByRole("combobox")
          .evaluate((element) => element.getBoundingClientRect().height),
      ).toBe(density === "compact" ? 28 : 36);
      await capture("stock");
      await page.goto(`/inventory/${deviceIds[0]}`);
      const take = page.getByRole("button", {
        name: t(locale, "parts.takeNamed", { name: "ELPAF51" }),
        exact: true,
      });
      await take.focus();
      await page.keyboard.press("Enter");
      await expect(panel).toContainText(t(locale, "parts.count", { count: 2 }));
      await expect(panel.getByRole("status")).toHaveText(t(locale, "parts.taken"));
      await expect(take).toBeEnabled();
      expect(
        await db.activityLog.count({
          where: { action: "PartTakenForDevice", entityId: deviceIds[0] },
        }),
      ).toBeGreaterThan(0);
      await capture("taken");
      await panel.getByRole("link", { name: "Epson ELPAF51", exact: true }).click();
      await expect(detail).toContainText(t(locale, "parts.count", { count: 2 }));
      await page.goto(`/inventory/models/${lampHostId}`);
      const lampParts = page.getByRole("region", { name: t(locale, "parts.heading"), exact: true });
      await expect(lampParts).toContainText("ELPLP93");
      await expect(lampParts).toContainText("ELPAF30");
      await capture("lamp-model");
    });
