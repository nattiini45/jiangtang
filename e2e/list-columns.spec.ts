import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { DEFAULT_COLUMNS, fieldColumnId } from "~/lib/list-columns/columns";
import { createInvite, resolveInvite, acceptInvite } from "~/domains/auth/users.queries.server";
import { pseudonymizeUser } from "~/domains/auth/gdpr.server";
import { runPrefix } from "./run";

const roomIds: string[] = [],
  fieldIds: string[] = [];
const renders = "test-results/list-columns";
test.afterEach(async () => {
  await db.listColumns.deleteMany();
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds.splice(0) } } });
  await db.customField.deleteMany({ where: { id: { in: fieldIds.splice(0) } } });
});
test.afterAll(() => db.$disconnect());

async function fixture(count = 3) {
  const prefix = `${runPrefix()}columns`;
  const projector = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  const computer = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "computer" } });
  const fields = [];
  for (let i = 0; i < 11; i++) {
    const field = await db.customField.create({
      data: {
        scope: "ROOM",
        key: `r_${prefix.replaceAll(/[^a-z0-9]/gi, "").slice(-20)}_${i}`,
        name: i === 0 ? "Nutzfläche" : i === 1 ? "Betriebsmodus" : `Raumangabe ${i + 1}`,
        type: i === 0 ? "NUMBER" : i === 1 ? "CHOICE" : "TEXT",
        unit: i === 0 ? "m²" : null,
        options:
          i === 1
            ? {
                create: [
                  { label: "Veranstaltung", position: 0 },
                  { label: "Probe", position: 1 },
                ],
              }
            : undefined,
      },
      include: { options: { orderBy: { position: "asc" } } },
    });
    fieldIds.push(field.id);
    fields.push(field);
  }
  const deviceField = await db.customField.create({
    data: {
      scope: "EQUIPMENT",
      key: `e_${prefix.replaceAll(/[^a-z0-9]/gi, "").slice(-20)}`,
      name: "Lichtquelle",
      type: "TEXT",
      kinds: { create: { kindId: projector.id } },
    },
  });
  fieldIds.push(deviceField.id);
  const rooms = [];
  for (let i = 0; i < count; i++) {
    const room = await db.room.create({
      data: {
        name: `Listensaal ${String(i + 1).padStart(3, "0")} · Veranstaltungsbereich mit langer Bezeichnung`,
        slug: `${prefix}-${i}`,
        customValues: Object.fromEntries(
          fields.flatMap((field, j) =>
            i === 2 && j === 0
              ? []
              : [
                  [
                    field.id,
                    j === 0
                      ? i === 0
                        ? 10
                        : 2.5
                      : j === 1
                        ? field.options[i % 2].id
                        : "Synthetische Betriebsangabe",
                  ],
                ],
          ),
        ),
      },
    });
    rooms.push(room);
    roomIds.push(room.id);
  }
  await db.equipment.createMany({
    data: rooms.map((room, i) => ({
      name: `Listengerät ${String(i + 1).padStart(3, "0")}`,
      roomId: room.id,
      category: i === 1 ? ("PC" as const) : ("PROJECTOR" as const),
      kindId: i === 1 ? computer.id : projector.id,
      customValues: { [deviceField.id]: "Laser" },
    })),
  });
  return { rooms, fields, deviceField, projector };
}

async function ready(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
}

test("admin adds and orders room columns, sorts by number, and members see the shared result live", async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { rooms, fields } = await fixture();
  const email = `${runPrefix()}columns-member@example.test`;
  const password = "synthetic-columns-member-1";
  const token = await createInvite(
    { email, name: "Synthetic columns member", initials: "CLM", role: "MEMBER" },
    { name: "Synthetic setup" },
  );
  await acceptInvite(await resolveInvite(token), password);
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const member = await context.newPage();
    await member.goto("/login?next=/rooms");
    await member.locator('input[name="email"]').fill(email);
    await member.locator('input[name="password"]').fill(password);
    await member.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(member).toHaveURL(/\/rooms$/);
    await expect(member.getByRole("button", { name: "Spalten", exact: true })).toHaveCount(0);
    await ready(page, "/rooms");
    await page.getByRole("button", { name: "Spalten", exact: true }).click();
    const panel = page.getByRole("region", { name: "Spalten", exact: true });
    await panel.getByRole("checkbox", { name: /Nutzfläche/ }).check();
    await panel.getByRole("checkbox", { name: /Betriebsmodus/ }).check();
    for (const key of [
      "rooms.col.campus",
      "rooms.col.equipment",
      "rooms.knownIssues",
      "rooms.lastChecked",
    ] as const)
      await panel.getByRole("checkbox", { name: t("de", key), exact: true }).uncheck();
    await panel.getByRole("button", { name: "Nutzfläche nach oben" }).click();
    mkdirSync(renders, { recursive: true });
    await page.screenshot({ path: `${renders}/column-panel.png`, fullPage: true });
    await panel.getByRole("button", { name: "Speichern", exact: true }).click();
    const header = page.locator(`[data-column-id='${fieldColumnId(fields[0].id)}']`).first();
    await expect(header).toBeVisible();
    await expect(
      member.locator(`[data-column-id='${fieldColumnId(fields[0].id)}']`).first(),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await page
      .getByRole("textbox", { name: t("de", "common.dataGrid.filterLabel") })
      .fill("Listensaal");
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    await expect(page.locator("[data-row-id]").first()).toHaveAttribute("data-row-id", rooms[1].id);
    await header.getByRole("button").click();
    await expect(header).toHaveAttribute("aria-sort", "descending");
    await expect(page.locator("[data-row-id]").first()).toHaveAttribute("data-row-id", rooms[0].id);
    await expect(page.locator("[data-row-id]").last()).toHaveAttribute("data-row-id", rooms[2].id);
    await page.getByRole("textbox", { name: t("de", "common.dataGrid.filterLabel") }).fill("Probe");
    await expect(page.locator("[data-row-id]")).toHaveCount(1);
    await expect(page.locator("[data-row-id]")).toHaveAttribute("data-row-id", rooms[1].id);
    await page
      .getByRole("textbox", { name: t("de", "common.dataGrid.filterLabel") })
      .fill("Listensaal");
    for (const width of [1280, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.screenshot({
        path: `${renders}/rooms-two-fields-${width}-de.png`,
        fullPage: true,
      });
    }
    await page.getByRole("button", { name: "Spalten", exact: true }).click();
    await panel.getByRole("button", { name: "Zurücksetzen", exact: true }).click();
    await panel.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(header).toHaveCount(0);
    expect((await db.listColumns.findUniqueOrThrow({ where: { scope: "ROOM" } })).columns).toEqual(
      DEFAULT_COLUMNS.ROOM,
    );
  } finally {
    await context.close();
    const user = await db.user.findUnique({ where: { email } });
    if (user) await pseudonymizeUser({ name: "Synthetic cleanup" }, user.id);
  }
});

test("device-kind fields stay empty on other kinds and rooms combine kind and text filters", async ({
  page,
}) => {
  const { rooms, deviceField, projector } = await fixture();
  await db.listColumns.create({
    data: { scope: "EQUIPMENT", columns: ["name", "kind", fieldColumnId(deviceField.id)] },
  });
  await ready(page, "/inventory");
  await page
    .getByRole("textbox", { name: t("de", "common.dataGrid.filterLabel") })
    .fill("Listengerät");
  const rows = page.locator("[data-row-id]");
  await expect(rows).toHaveCount(3);
  await expect(
    rows
      .filter({ hasText: "Listengerät 002" })
      .locator(`[data-column-id='${fieldColumnId(deviceField.id)}']`),
  ).toHaveText("—");
  await page.getByRole("button", { name: "Spalten", exact: true }).click();
  await expect(page.getByRole("region", { name: "Spalten" })).toContainText(
    `Text · ${projector.name}`,
  );
  mkdirSync(renders, { recursive: true });
  await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await page.screenshot({ path: `${renders}/devices-kind-field.png`, fullPage: true });
  await ready(page, "/rooms");
  await page
    .getByLabel(t("de", "inventory.list.filterKind"), { exact: true })
    .selectOption(projector.id);
  await expect(page).toHaveURL(new RegExp(`kindId=${projector.id}`));
  await page
    .getByRole("textbox", { name: t("de", "common.dataGrid.filterLabel") })
    .fill("Listensaal 003");
  await expect(rows).toHaveCount(1);
  await expect(rows).toHaveAttribute("data-row-id", rooms[2].id);
  await page.screenshot({ path: `${renders}/rooms-kind-filter.png`, fullPage: true });
});

test("300 rows and twelve columns fit inside the grid at both widths, languages and densities", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { fields } = await fixture(300);
  await db.listColumns.create({
    data: { scope: "ROOM", columns: ["name", ...fields.map((field) => fieldColumnId(field.id))] },
  });
  const equipmentFields = [];
  for (let i = 0; i < 6; i++) {
    const field = await db.customField.create({
      data: {
        scope: "EQUIPMENT",
        key: `e_${runPrefix().replaceAll("-", "")}_${i}`,
        name: `Geräteangabe ${i + 1}`,
        type: "TEXT",
      },
    });
    fieldIds.push(field.id);
    equipmentFields.push(field);
  }
  await db.listColumns.create({
    data: {
      scope: "EQUIPMENT",
      columns: [
        ...DEFAULT_COLUMNS.EQUIPMENT,
        ...equipmentFields.map((field) => fieldColumnId(field.id)),
      ],
    },
  });
  mkdirSync(renders, { recursive: true });
  for (const width of [1280, 1920])
    for (const locale of ["de", "en"] as const)
      for (const density of ["comfortable", "compact"]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.context().addCookies(
          Object.entries({ locale, density }).map(([name, value]) => ({
            name,
            value,
            url: baseURL!,
          })),
        );
        for (const path of ["/rooms", "/inventory"]) {
          await ready(page, path);
          await page
            .getByRole("textbox", { name: t(locale, "common.dataGrid.filterLabel") })
            .fill(path === "/rooms" ? "Listensaal" : "Listengerät");
          await page.locator("[data-column-id='name']").first().getByRole("button").click();
          await expect(page.locator("aside").first()).toBeVisible();
          await expect(page.locator('main [role="columnheader"][data-column-id]')).toHaveCount(12);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          const scroll = page.locator("main .overflow-auto").last();
          expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
          const name = page.locator("[data-row-id] [data-column-id='name']").first();
          const left = (await name.boundingBox())!.x;
          await scroll.evaluate((el) => {
            el.scrollLeft = el.scrollWidth;
          });
          expect((await name.boundingBox())!.x).toBeCloseTo(left, 0);
          await scroll.evaluate((el) => {
            el.scrollLeft = 0;
            el.scrollTop = el.scrollHeight;
          });
          await expect
            .poll(() => page.locator("[data-row-id]").last().innerText())
            .toContain(path === "/rooms" ? "Listensaal 300" : "Listengerät 300");
          await scroll.evaluate((el) => {
            el.scrollTop = 0;
          });
          await expect(page.locator("[data-row-id]").first()).toBeVisible();
          await page.screenshot({
            path: `${renders}/${path.slice(1)}-${width}-${locale}-${density}.png`,
            fullPage: true,
          });
          await page
            .getByRole("button", { name: t(locale, "fields.columns.title"), exact: true })
            .click();
          const panel = page.getByRole("region", {
            name: t(locale, "fields.columns.title"),
            exact: true,
          });
          await expect(panel).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.screenshot({
            path: `${renders}/${path.slice(1)}-panel-${width}-${locale}-${density}.png`,
            fullPage: true,
          });
          await panel
            .getByRole("button", { name: t(locale, "common.cancel"), exact: true })
            .click();
        }
      }
});
