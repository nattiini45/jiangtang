import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { propertiesForKind } from "~/lib/equipment-kinds/properties";
import { runPrefix } from "./run";
import { createInvite, resolveInvite, acceptInvite } from "~/domains/auth/users.queries.server";
import { pseudonymizeUser } from "~/domains/auth/gdpr.server";

const devices: string[] = [],
  models: string[] = [],
  ownFields: string[] = [];
let saved: {
  id: string;
  name: string;
  position: number;
  renamed: boolean;
  archivedAt: Date | null;
}[] = [];
test.afterEach(async () => {
  await db.equipment.deleteMany({ where: { id: { in: devices.splice(0) } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: models.splice(0) } } });
  await db.customField.deleteMany({ where: { id: { in: ownFields.splice(0) } } });
  for (const { id, ...data } of saved) await db.customField.update({ where: { id }, data });
  saved = [];
});
test.afterAll(() => db.$disconnect());

test("members read retained values but cannot clear them or configure properties", async ({
  browser,
  baseURL,
}) => {
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "computer" } });
  const device = await db.equipment.create({
    data: {
      name: `${runPrefix()}Retained PC`,
      category: "PC",
      kindId: kind.id,
      dellServiceTag: "x".repeat(201),
    },
  });
  devices.push(device.id);
  const email = `${runPrefix()}property-member@example.test`;
  const password = "synthetic-property-member-1";
  const token = await createInvite(
    { email, name: "Synthetic property member", initials: "SPM", role: "MEMBER" },
    { name: "Synthetic setup" },
  );
  await acceptInvite(await resolveInvite(token), password);
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    locale: "de-DE",
  });
  try {
    const page = await context.newPage();
    await page.goto(`/login?next=/inventory/${device.id}`);
    await page.locator('input[name="email"]').fill(email);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/inventory/${device.id}$`));
    await expect(page.getByText(t("de", "fields.legacy.retained"), { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: t("de", "fields.legacy.clear"), exact: true }),
    ).toHaveCount(0);
    const refused = await context.request.post(`/inventory/${device.id}`, {
      headers: { Origin: baseURL! },
      form: { _action: "clearLegacy", column: "dellServiceTag" },
    });
    expect(refused.status()).toBe(403);
    expect((await context.request.get("/admin/structure?tab=fields")).status()).toBe(403);
    expect(
      (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).dellServiceTag,
    ).toBe("x".repeat(201));
  } finally {
    await context.close();
    const user = await db.user.findUnique({ where: { email } });
    if (user) await pseudonymizeUser({ name: "Synthetic cleanup" }, user.id);
  }
});

for (const locale of ["de", "en"] as const)
  for (const density of ["comfortable", "compact"] as const)
    test(`library controls and calm conditional forms in ${locale} ${density}`, async ({
      page,
      baseURL,
    }) => {
      test.setTimeout(180_000);
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);
      await page.setViewportSize({ width: 1280, height: 1000 });
      const renders = "test-results/library-controls";
      mkdirSync(renders, { recursive: true });
      const capture = async (name: string) => {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await expect(page.locator("aside").first()).toBeVisible();
        await page.screenshot({ path: `${renders}/${name}-${locale}-${density}.png` });
      };
      const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
      const fields = await db.customField.findMany({
        where: { kinds: { some: { kindId: kind.id } }, systemKey: { not: null } },
        include: { options: true },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      });
      saved = fields.map(({ id, name, position, renamed, archivedAt }) => ({
        id,
        name,
        position,
        renamed,
        archivedAt,
      }));
      const light = fields.find((field) => field.systemKey === "projector.light_source")!;
      const lampDate = fields.find((field) => field.systemKey === "projector.lamp_change")!;
      const memory = fields.find((field) => field.systemKey === "projector.lens_memory")!;
      const own = await db.customField.create({
        data: {
          scope: "EQUIPMENT",
          key: `${runPrefix()}own`.replaceAll("-", "_"),
          name: "Synthetic house property",
          type: "TEXT",
          kinds: { create: { kindId: kind.id } },
        },
      });
      ownFields.push(own.id);
      const linked = [];
      for (const source of ["lamp", "laser"]) {
        const model = await db.equipmentModel.create({
          data: {
            name: `${runPrefix()}Synthetic ${source}`,
            kindId: kind.id,
            category: "PROJECTOR",
            customValues: {
              [light.id]: light.options.find((option) => option.systemKey === source)!.id,
            },
          },
        });
        models.push(model.id);
        const device = await db.equipment.create({
          data: {
            name: `${runPrefix()}Synthetic ${source}`,
            kindId: kind.id,
            category: "PROJECTOR",
            modelId: model.id,
            customValues: { [lampDate.id]: "2025-03-04", [memory.id]: "Synthetic preset" },
          },
        });
        devices.push(device.id);
        linked.push({ device, model });
      }
      await page.goto(`/inventory/${linked[0].device.id}`);
      await expect(page.locator(`input[id="cf.${lampDate.id}"]`)).toHaveCount(1);
      await capture("lamp-page");
      await page.goto(`/inventory/${linked[1].device.id}`);
      await expect(page.locator(`input[id="cf.${lampDate.id}"]`)).toHaveCount(0);
      await expect(
        page
          .locator("[data-field-values]")
          .getByText(locale === "de" ? "Letzter Lampenwechsel" : "Last lamp replacement", {
            exact: true,
          }),
      ).toHaveCount(0);
      await capture("laser-page");
      await page
        .getByRole("link", { name: t(locale, "fields.model.edit"), exact: true })
        .first()
        .scrollIntoViewIfNeeded();
      await expect(
        page.locator("form legend").filter({ hasText: t(locale, "fields.moreDetails") }),
      ).toHaveCount(0);
      await capture("laser-form");
      await page.goto(`/inventory/models/${linked[1].model.id}`);
      await page.getByText(t(locale, "inventory.models.editSummary"), { exact: true }).click();
      const sourceInput = page.locator(`select[id="cf.${light.id}"]`);
      await sourceInput.selectOption(
        light.options.find((option) => option.systemKey === "lamp")!.id,
      );
      const lampCount = fields.find((field) => field.systemKey === "projector.lamp_count")!;
      await expect(page.locator(`input[id="cf.${lampCount.id}"]`)).toHaveCount(1);
      await sourceInput.selectOption(
        light.options.find((option) => option.systemKey === "laser")!.id,
      );
      await expect(page.locator(`input[id="cf.${lampCount.id}"]`)).toHaveCount(0);
      await expect(
        page.locator("form legend").filter({ hasText: t(locale, "fields.moreDetails") }),
      ).toHaveCount(0);
      await sourceInput.scrollIntoViewIfNeeded();
      await capture("model-form");
      await page.goto(`/admin/structure?tab=fields&scope=EQUIPMENT&kind=${kind.id}`);
      await expect(
        page.getByRole("link", { name: t(locale, "admin.structure.fields"), exact: true }),
      ).toBeVisible();
      const library = page.locator("details").filter({
        has: page.getByText(
          t(locale, "fields.library.title", { count: propertiesForKind("projector").length }),
          { exact: true },
        ),
      });
      await expect(library).not.toHaveAttribute("open", "");
      await expect(page.locator(`[data-field-id="${own.id}"]`)).toBeVisible();
      await library.locator(":scope > summary").click();
      const row = page.locator(`[data-field-id="${memory.id}"]`);
      const originalName = await row.locator("button").first().innerText();
      await row.locator("button").first().click();
      await row
        .getByLabel(t(locale, "admin.structure.name"), { exact: true })
        .fill("Synthetic preset property");
      await row.getByRole("button", { name: t(locale, "common.save"), exact: true }).click();
      await expect(row.getByRole("button").first()).toContainText("Synthetic preset property");
      await row
        .getByRole("button", { name: t(locale, "fields.library.resetName"), exact: true })
        .click();
      await expect(row.getByRole("button").first()).toHaveText(originalName);
      await row
        .getByRole("button", {
          name: t(locale, "fields.admin.moveUp", {
            name: propertiesForKind("projector").find((field) => field.key === memory.systemKey)![
              locale
            ],
          }),
          exact: true,
        })
        .click();
      await expect
        .poll(
          async () =>
            (await db.customField.findUniqueOrThrow({ where: { id: memory.id } })).position,
        )
        .not.toBe(memory.position);
      const metadata = propertiesForKind("projector");
      const previous = fields
        .filter((field) => {
          const property = metadata.find((property) => property.key === field.systemKey);
          return (
            property?.level === "DEVICE" &&
            property.weight === "useful" &&
            field.position < memory.position
          );
        })
        .at(-1)!;
      await page.goto(`/inventory/${linked[1].device.id}`);
      expect(
        await page.evaluate(
          ([first, second]) => {
            const a = document.querySelector(`[id="cf.${first}"]`)!;
            const b = document.querySelector(`[id="cf.${second}"]`)!;
            return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
          },
          [memory.id, previous.id],
        ),
      ).toBe(true);
      await page.goto(`/admin/structure?tab=fields&scope=EQUIPMENT&kind=${kind.id}`);
      await library.locator(":scope > summary").click();
      await row
        .getByRole("button", { name: new RegExp(locale === "de" ? "ausblenden$" : "^Hide ") })
        .click();
      const hidden = library.locator("details");
      await hidden.locator("summary").click();
      await expect(hidden.locator(`[data-field-id="${memory.id}"]`)).toBeVisible();
      await hidden.scrollIntoViewIfNeeded();
      await capture("properties-hidden");
      await page.setViewportSize({ width: 1920, height: 1080 });
      await capture("properties-wide");
      await page.goto(`/inventory/${linked[1].device.id}`);
      await expect(page.locator(`input[id="cf.${memory.id}"]`)).toHaveCount(0);
      expect(
        (await db.equipment.findUniqueOrThrow({ where: { id: linked[1].device.id } })).customValues,
      ).toMatchObject({ [memory.id]: "Synthetic preset" });
      await page.goto(`/admin/structure?tab=fields&scope=EQUIPMENT&kind=${kind.id}`);
      await library.locator(":scope > summary").click();
      await hidden.locator("summary").click();
      await hidden
        .getByRole("button", { name: new RegExp(locale === "de" ? "wieder anzeigen$" : "^Show ") })
        .click();
      await expect(hidden).toHaveCount(0);
      await page.goto(`/inventory/${linked[1].device.id}`);
      await expect(page.locator(`input[id="cf.${memory.id}"]`)).toHaveCount(1);
      const computer = await db.equipmentKind.findUniqueOrThrow({
        where: { systemKey: "computer" },
      });
      const old = await db.equipment.create({
        data: {
          name: `${runPrefix()}Synthetic legacy PC`,
          category: "PC",
          kindId: computer.id,
          dellServiceTag: "x".repeat(201),
        },
      });
      devices.push(old.id);
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.goto(`/inventory/${old.id}`);
      await expect(
        page.getByText(t(locale, "fields.legacy.retained"), { exact: true }),
      ).toBeVisible();
      await capture("retained-value");
      await page
        .getByRole("button", { name: t(locale, "fields.legacy.clear"), exact: true })
        .click();
      await expect(
        page.getByText(t(locale, "fields.legacy.retained"), { exact: true }),
      ).toHaveCount(0);
      expect(
        (await db.equipment.findUniqueOrThrow({ where: { id: old.id } })).dellServiceTag,
      ).toBeNull();
    });
