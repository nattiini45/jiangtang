import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { linkCatalogModel } from "~/domains/catalog/catalog.library.server";
import { addPartStock } from "~/domains/inventory/inventory.parts.mutations.server";
import { startRound } from "~/domains/functions/rounds.mutations.server";
import { recordReading } from "~/domains/readings/readings.mutations.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

test.describe.configure({ mode: "serial" });
const renders = "test-results/readings";
const deviceIds: string[] = [];
let roomId: string, slug: string, stockId: string, roundId: string;
const deviceName = "Synthetischer Projektor 33 · EB-L1750U";
test.beforeAll(async () => {
  const actor = await db.user.findFirstOrThrow({ where: { role: "ADMIN", isActive: true } });
  const model = await linkCatalogModel(actor, "epson-eb-l1750u");
  const filter = await db.equipmentModel.findUniqueOrThrow({
    where: { catalogKey: "epson-elpaf51" },
  });
  stockId = (await addPartStock(actor, filter.id, 2)).id;
  slug = `${runPrefix()}readings-room-33`;
  roomId = (await db.room.create({ data: { name: "Synthetischer Raum 33", slug } })).id;
  for (let index = 0; index < 16; index++) {
    const device = await db.equipment.create({
      data: {
        name:
          index === 0
            ? deviceName
            : `Synthetisches Gerät ${index + 1} mit einer absichtlich langen Bezeichnung für die Darstellung`,
        roomId,
        kindId: model.kindId,
        modelId: model.id,
        category: "PROJECTOR",
      },
    });
    deviceIds.push(device.id);
  }
  roundId = (await startRound(actor, { name: "Synthetischer Messwertrundgang", roomIds: [roomId] }))
    .id;
  mkdirSync(renders, { recursive: true });
});
test.afterAll(async () => {
  await db.$executeRaw`TRUNCATE "EquipmentReading"`;
  await db.roomCheck.deleteMany({ where: { roundId } });
  await db.roundRoom.deleteMany({ where: { roundId } });
  await db.round.delete({ where: { id: roundId } });
  await db.equipment.deleteMany({ where: { id: { in: deviceIds } } });
  await db.inventoryItem.delete({ where: { id: stockId } });
  await db.room.delete({ where: { id: roomId } });
  await db.$disconnect();
});

test("phone entry puts the rated-life warning, dated reading and stocked filter on the device, home and due list", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "locale", value: "de", url: baseURL! }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/m/rooms/${slug}`);
  await page
    .getByRole("link", { name: t("de", "readings.enterAndHistory"), exact: true })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: deviceName, exact: true })).toBeVisible();
  const measure = page.locator('[data-reading-measure="projector.light_source_hours"]');
  const trigger = measure.getByRole("button", {
    name: "Eintragen · Lichtquellenstunden",
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const form = page.getByRole("form", { name: `${deviceName} · Lichtquellenstunden`, exact: true });
  const value = form.getByRole("textbox", { name: "Lichtquellenstunden (h)", exact: true });
  await value.fill("18500");
  await value.press("Tab");
  const observed = await form.locator('[name="observedAt"]').inputValue();
  const agent = await page.evaluate(async (modulePath) => {
    const { uiAgent } = await import(modulePath);
    return uiAgent.act({
      steps: [{ ref: "Lichtquellenstunden (h)", action: "setValue", args: [18500] }],
    });
  }, "/app/lib/ui-agent.client.ts");
  expect(agent.ok).toBe(true);
  await form
    .getByRole("button", { name: "Messwert speichern · Lichtquellenstunden", exact: true })
    .click();
  await expect(form.getByRole("status")).toHaveText("Messwert gespeichert.");
  await expect(measure).toContainText("Bald fällig");
  await expect(measure).toContainText("20.000 h");
  await expect(measure).toContainText("18.500");
  await expect(measure).toContainText("Von Hand");
  expect(observed).not.toBe("");
  await trigger.click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${renders}/phone-reading.png` });
  await page.getByRole("link", { name: "Messwertverlauf", exact: true }).click();
  await expect(page.getByRole("region", { name: "Messwertverlauf", exact: true })).toContainText(
    "18500",
  );
  for (const path of ["/m", "/m/due"]) {
    await page.goto(path);
    const item = page
      .locator("li")
      .filter({
        has: page.getByRole("link", { name: /Synthetischer Raum 33 · Synthetischer Projektor 33/ }),
      })
      .first();
    await expect(item).toContainText("Bald fällig");
    await expect(item).toContainText("ELPAF51");
    await expect(item).toContainText(t("de", "parts.count", { count: 2 }));
  }
});

for (const locale of ["de", "en"] as const)
  for (const density of ["comfortable", "compact"] as const)
    test(`desktop readings and due fit both widths in ${locale} ${density}`, async ({
      page,
      baseURL,
    }) => {
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);
      for (const width of [1280, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const [name, path] of [
          ["device", `/inventory/${deviceIds[0]}`],
          ["readings", `/inventory/${deviceIds[0]}/readings?history=1`],
          ["due", "/due"],
          ["home", "/"],
        ]) {
          await page.goto(path);
          await expect(page.locator("aside").first()).toBeVisible();
          await expect(
            page.getByText(t(locale, "readings.state.soon"), { exact: false }).first(),
          ).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.screenshot({ path: `${renders}/${name}-${width}-${locale}-${density}.png` });
        }
      }
    });

test("a reading stays inside its round and replacing the filter preserves light-source hours", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "locale", value: "de", url: baseURL! }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/m/rounds/${roundId}/${roomId}`);
  await page.getByRole("button", { name: deviceName, exact: true }).click();
  const device = page
    .getByRole("region", { name: "Messwerte", exact: true })
    .filter({ has: page.getByRole("heading", { name: deviceName, exact: true }) });
  const measure = device.locator('[data-reading-measure="projector.filter_hours"]');
  await measure
    .getByRole("button", { name: "Eintragen · Filterbetriebsstunden", exact: true })
    .click();
  const form = device.getByRole("form", {
    name: `${deviceName} · Filterbetriebsstunden`,
    exact: true,
  });
  await form.getByRole("textbox", { name: "Filterbetriebsstunden (h)", exact: true }).fill("900");
  await form.getByRole("textbox", { name: "Filterbetriebsstunden (h)", exact: true }).press("Tab");
  await form
    .getByRole("button", { name: "Messwert speichern · Filterbetriebsstunden", exact: true })
    .click();
  await expect(form.getByRole("status")).toHaveText("Messwert gespeichert.");
  await expect(measure).toContainText("Rundgang");
  await expect(page).toHaveURL(`/m/rounds/${roundId}/${roomId}`);
  await measure
    .getByRole("button", { name: "Eintragen · Filterbetriebsstunden", exact: true })
    .click();
  await device.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -72));
  await page.screenshot({ path: `${renders}/phone-round.png` });
  await page.goto(`/m/inventory/${deviceIds[0]}/readings`);
  const replacement = page
    .getByRole("form", { name: "Epson ELPAF51", exact: true })
    .filter({ has: page.locator(`input[value="${stockId}"]`) });
  await replacement.getByRole("button", { name: "Einbauen und entnehmen", exact: true }).click();
  await expect(
    page.getByText("Einbau dokumentiert und Lagerbestand aktualisiert.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-reading-measure="projector.filter_hours"]')).toContainText(
    "Zähler zurückgesetzt",
  );
  await expect(page.locator('[data-reading-measure="projector.light_source_hours"]')).toContainText(
    "18.500",
  );
  expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: stockId } })).quantity).toBe(1);
});

test("an old reading visibly lowers trust instead of being extrapolated", async ({ page }) => {
  const actor = await db.user.findFirstOrThrow({ where: { role: "ADMIN", isActive: true } });
  const field = await db.customField.findUniqueOrThrow({
    where: { systemKey: "projector.light_source_hours" },
  });
  await recordReading(actor, {
    equipmentId: deviceIds[1],
    fieldId: field.id,
    value: 19000,
    observedAt: new Date("2020-01-01T12:00:00Z"),
  });
  await page.goto(`/m/inventory/${deviceIds[1]}/readings`);
  const measure = page.locator('[data-reading-measure="projector.light_source_hours"]');
  await expect(measure).toContainText("Über ein Jahr alt");
  await expect(measure).toContainText("19.000");
});
