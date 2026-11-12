import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";
import { emitChange } from "~/lib/realtime/emit.server";

const fieldIds: string[] = [],
  roomIds: string[] = [];
const renders = "test-results/field-values";
test.afterEach(async () => {
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds.splice(0) } } });
  await db.customField.deleteMany({ where: { id: { in: fieldIds.splice(0) } } });
});
test.afterAll(() => db.$disconnect());

async function fixture() {
  const prefix = `${runPrefix()}properties`;
  const projector = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  const computer = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "computer" } });
  const types = [
    "TEXT",
    "LONG_TEXT",
    "NUMBER",
    "BOOLEAN",
    "CHOICE",
    "MULTI_CHOICE",
    "DATE",
    "LINK",
  ] as const;
  const names = [
    "Demo-Kennung",
    "Betriebshinweise",
    "Betriebsdauer",
    "Fernzugriff",
    "Betriebsmodus",
    "Signalwege",
    "Prüftag",
    "Dokumentation",
  ];
  const fields = [];
  for (let index = 0; index < 40; index++) {
    const type =
      index < 8 ? types[index] : index === 8 ? "CHOICE" : index === 9 ? "MULTI_CHOICE" : "TEXT";
    const field = await db.customField.create({
      data: {
        scope: "EQUIPMENT",
        key: `f_${prefix.replaceAll(/[^a-z0-9]/gi, "").slice(-22)}_${index}`,
        name:
          names[index] ??
          (index === 8
            ? "Archivierte Auswahl"
            : index === 9
              ? "Weitere Signalwege"
              : `Angabe ${index + 1} mit einer langen verständlichen Bezeichnung`),
        type,
        position: index,
        section: index < 4 ? "Betrieb" : index < 8 ? "Dokumentation" : "Weitere Angaben",
        helpText: index === 0 ? "Eine Bezeichnung, die das Team vor Ort wiedererkennt." : null,
        unit: type === "NUMBER" ? "h" : null,
        kinds: index === 0 ? undefined : { create: { kindId: projector.id } },
        options:
          type === "CHOICE" || type === "MULTI_CHOICE"
            ? {
                create: Array.from({ length: index === 9 ? 12 : 3 }, (_, n) => ({
                  label: n === 2 ? "Alter Anschluss" : `Option ${n + 1}`,
                  position: n,
                  archivedAt: n === 2 ? new Date("2040-01-01T00:00:00Z") : null,
                })),
              }
            : undefined,
      },
      include: { options: { orderBy: { position: "asc" } } },
    });
    fieldIds.push(field.id);
    fields.push(field);
  }
  const roomFields = [];
  for (let index = 0; index < 10; index++) {
    const field = await db.customField.create({
      data: {
        scope: "ROOM",
        key: `r_${prefix.replaceAll(/[^a-z0-9]/gi, "").slice(-22)}_${index}`,
        name: index === 0 ? "Zugangshinweis" : `Raumangabe ${index + 1}`,
        type: "TEXT",
        section: index < 5 ? "Zugang" : null,
        position: index,
      },
    });
    fieldIds.push(field.id);
    roomFields.push(field);
  }
  const values = Object.fromEntries(
    fields.map((field, index) => [
      field.id,
      field.type === "NUMBER"
        ? 12.5
        : field.type === "BOOLEAN"
          ? false
          : field.type === "DATE"
            ? "2040-02-29"
            : field.type === "LINK"
              ? "https://example.org/manual"
              : field.type === "CHOICE"
                ? field.options[index === 8 ? 2 : 0].id
                : field.type === "MULTI_CHOICE"
                  ? [field.options[0].id, ...(index === 9 ? [field.options[2].id] : [])]
                  : index === 0
                    ? "Demo-Projektor"
                    : "Synthetische Betriebsangabe",
    ]),
  );
  const room = await db.room.create({
    data: {
      name: "Demo-Saal · 30 Geräte",
      slug: `${prefix}-hall`,
      customValues: Object.fromEntries(
        roomFields.map((field) => [field.id, "Synthetische Raumangabe"]),
      ),
    },
  });
  roomIds.push(room.id);
  const devices = [];
  for (let index = 0; index < 30; index++)
    devices.push(
      await db.equipment.create({
        data: {
          roomId: room.id,
          kindId: projector.id,
          category: "PROJECTOR",
          name: `Projektor ${String(index + 1).padStart(2, "0")} · Einbau mit langer Gerätebezeichnung`,
          customValues: values,
        },
      }),
    );
  return { room, devices, fields, roomFields, projector, computer, values };
}

async function checkWidth(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator("aside").first()).toBeVisible();
  expect(
    await page
      .locator("main")
      .evaluate((element) =>
        [...element.querySelectorAll("*")]
          .filter((child) => getComputedStyle(child).overflowX === "auto")
          .every((child) => child.scrollWidth <= child.clientWidth),
      ),
  ).toBe(true);
}

test("fills every device property type, preserves archived options and swaps kinds live", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { room, devices, fields, computer, projector, values } = await fixture();
  await page.context().addCookies([
    { name: "locale", value: "de", url: baseURL! },
    { name: "view", value: "desktop", url: baseURL! },
  ]);
  await page.goto(`/inventory/${devices[0].id}`);
  await page.getByLabel(fields[0].name, { exact: true }).fill("Neue Demo-Kennung");
  await db.equipment.update({
    where: { id: devices[0].id },
    data: {
      customValues: {
        ...values,
        [fields[0].id]: "Andere Änderung",
        [fields[39].id]: "Neu vom Team",
      },
    },
  });
  await emitChange({ entityType: "equipment", id: devices[0].id, op: "updated" });
  await expect(page.locator("[data-field-values]")).toContainText("Andere Änderung");
  await expect(page.getByLabel(fields[0].name, { exact: true })).toHaveValue("Neue Demo-Kennung");
  await expect(page.getByLabel(fields[39].name, { exact: true })).toHaveValue("Neu vom Team");
  await page.getByLabel(t("de", "inventory.kind"), { exact: true }).selectOption(computer.id);
  await expect(page.getByRole("status")).toContainText("39 gespeicherte Werte");
  await expect(page.getByLabel(fields[2].name, { exact: true })).toHaveCount(0);
  await expect(page.getByLabel(fields[0].name, { exact: true })).toHaveValue("Neue Demo-Kennung");
  await page.getByLabel(t("de", "inventory.kind"), { exact: true }).selectOption(projector.id);
  await page.getByLabel(fields[1].name, { exact: true }).fill("Zeile eins\nZeile zwei");
  await page.getByLabel(fields[2].name, { exact: true }).fill("not a number");
  await page.getByRole("button", { name: t("de", "inventory.detail.submit"), exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(t("de", "fields.error.number"));
  await page.getByLabel(fields[2].name, { exact: true }).fill("1234,5");
  await page.getByLabel(fields[3].name, { exact: true }).selectOption("true");
  await page.getByLabel(fields[4].name, { exact: true }).selectOption(fields[4].options[1].id);
  await page
    .getByRole("group", { name: fields[5].name, exact: true })
    .getByLabel("Option 2", { exact: true })
    .check();
  await page.getByLabel(fields[6].name, { exact: true }).fill("2040-03-01");
  await page.getByLabel(fields[7].name, { exact: true }).fill("https://example.org/updated");
  await expect(page.getByLabel(fields[8].name, { exact: true })).toHaveValue(
    fields[8].options[2].id,
  );
  await expect(
    page.getByLabel(fields[8].name, { exact: true }).locator("option:checked"),
  ).toHaveText("Alter Anschluss (archiviert)");
  await page.getByRole("button", { name: t("de", "inventory.detail.submit"), exact: true }).click();
  const expected = {
    [fields[0].id]: "Neue Demo-Kennung",
    [fields[1].id]: "Zeile eins\nZeile zwei",
    [fields[2].id]: 1234.5,
    [fields[3].id]: true,
    [fields[4].id]: fields[4].options[1].id,
    [fields[5].id]: [fields[5].options[0].id, fields[5].options[1].id],
    [fields[6].id]: "2040-03-01",
    [fields[7].id]: "https://example.org/updated",
    [fields[8].id]: fields[8].options[2].id,
    [fields[9].id]: [fields[9].options[0].id, fields[9].options[2].id],
    [fields[39].id]: "Neu vom Team",
  };
  await expect
    .poll(
      async () =>
        (await db.equipment.findUniqueOrThrow({ where: { id: devices[0].id } })).customValues,
    )
    .toMatchObject(expected);
  await expect(page.locator("[data-field-values]")).toContainText("Neue Demo-Kennung");
  await expect(page.locator("[data-field-values]")).toContainText("1.234,5 h");
  await expect(page.locator("[data-field-values]")).toContainText("Ja");
  for (const field of fields.slice(0, 8))
    await expect(
      page.locator("[data-field-values] dt").filter({ hasText: new RegExp(`^${field.name}$`) }),
    ).toBeVisible();
  await expect(page.locator("[data-field-values]")).toContainText("Zeile eins");
  await expect(page.locator("[data-field-values]")).toContainText("01.03.2040");
  const selected = page
    .locator("[data-field-values] dl > div")
    .filter({ has: page.locator("dt").filter({ hasText: new RegExp(`^${fields[5].name}$`) }) });
  await expect(selected.getByText("Option 1", { exact: true })).toBeVisible();
  await expect(selected.getByText("Option 2", { exact: true })).toBeVisible();
  await expect(
    page.locator("[data-field-values]").getByRole("link", { name: /example.org\/updated/ }),
  ).toHaveAttribute("target", "_blank");
  const multi = page.getByRole("group", { name: fields[9].name, exact: true });
  await expect(multi).toContainText(t("de", "fields.form.archivedSelection"));
  await multi.locator("summary").click();
  await multi.getByRole("searchbox").fill("Option 12");
  await multi.getByLabel("Option 12", { exact: true }).check();
  await page.getByLabel(fields[8].name, { exact: true }).selectOption("");
  await page.getByRole("button", { name: t("de", "inventory.detail.submit"), exact: true }).click();
  await expect
    .poll(
      async () =>
        (await db.equipment.findUniqueOrThrow({ where: { id: devices[0].id } })).customValues,
    )
    .toMatchObject({ [fields[9].id]: [fields[9].options[0].id, fields[9].options[11].id] });
  await expect(
    page
      .getByLabel(fields[8].name, { exact: true })
      .locator(`option[value='${fields[8].options[2].id}']`),
  ).toHaveCount(0);
  await page.goto(`/rooms/${room.slug}`);
  const row = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: devices[0].name!, exact: true }) });
  await row
    .getByRole("button", {
      name: t("de", "fields.values.forDevice", { name: devices[0].name! }),
      exact: true,
    })
    .click();
  await expect(row.locator("[data-field-values]")).toContainText("Neue Demo-Kennung");
  await expect(row.locator("[data-field-values]")).toContainText("1.234,5 h");
  await expect(row.locator("[data-field-values]")).toContainText("Zeile eins");
  await expect(row.locator("[data-field-values]")).toContainText("Option 2");
  await expect(row.locator("[data-field-values]")).toContainText("01.03.2040");
});

test("new room and device forms save properties alongside built-in fields", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const { fields, roomFields, projector } = await fixture();
  await page.context().addCookies([
    { name: "locale", value: "de", url: baseURL! },
    { name: "view", value: "desktop", url: baseURL! },
  ]);
  const name = `${runPrefix()}New property room`;
  await page.goto("/rooms/new");
  await page.getByLabel(t("de", "rooms.form.name"), { exact: true }).fill(name);
  await page.getByLabel(roomFields[0].name, { exact: true }).fill("Schlüssel beim Empfang");
  await page.getByRole("button", { name: t("de", "rooms.new.submit"), exact: true }).click();
  await expect(page.locator("[data-field-values]")).toContainText("Schlüssel beim Empfang");
  const room = await db.room.findFirstOrThrow({ where: { name } });
  roomIds.push(room.id);
  await page.goto(`/rooms/${room.slug}/edit`);
  await expect(page.getByLabel(roomFields[0].name, { exact: true })).toHaveValue(
    "Schlüssel beim Empfang",
  );
  await page.getByLabel(roomFields[0].name, { exact: true }).fill("Zugang über den Seiteneingang");
  await page.getByRole("button", { name: t("de", "rooms.edit.submit"), exact: true }).click();
  await expect(page.locator("[data-field-values]")).toContainText("Zugang über den Seiteneingang");
  await page.goto(`/inventory/new?roomId=${room.id}`);
  await page.getByLabel(t("de", "inventory.kind"), { exact: true }).selectOption(projector.id);
  await page.getByLabel(fields[2].name, { exact: true }).fill("7,25");
  await page.getByRole("button", { name: t("de", "inventory.new.submit"), exact: true }).click();
  await expect(page.locator("[data-field-values]")).toContainText("7,25 h");
  await page.context().addCookies([{ name: "view", value: "mobile", url: baseURL! }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/m/rooms/${room.slug}`);
  await expect(page.locator("[data-field-values]").first()).toContainText(
    "Zugang über den Seiteneingang",
  );
  const device = await db.equipment.findFirstOrThrow({ where: { roomId: room.id } });
  const mobileToggle = page.locator(`button[aria-controls='values-${device.id}']`);
  await expect(mobileToggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`#values-${device.id}`)).not.toBeVisible();
  await mobileToggle.click();
  await expect(mobileToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`#values-${device.id}`)).toContainText("7,25 h");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const locale of ["de", "en"] as const)
  for (const density of ["comfortable", "compact"] as const) {
    test(`properties at maximum scale in ${locale} ${density}`, async ({ page, baseURL }) => {
      test.setTimeout(180_000);
      const { room, devices, fields, roomFields } = await fixture();
      mkdirSync(renders, { recursive: true });
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);
      for (const width of [1280, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        const capture = async (name: string) => {
          await checkWidth(page);
          await page.screenshot({ path: `${renders}/${name}-${locale}-${density}-${width}.png` });
        };
        await page.goto(`/inventory/${devices[0].id}`);
        await expect(page.locator("[data-field-values]")).toContainText("Demo-Projektor");
        await capture("device-page");
        await page.getByLabel(fields[0].name, { exact: true }).scrollIntoViewIfNeeded();
        await capture("device-form");
        await expect(page.locator("form label").filter({ hasText: fields[39].name })).toBeVisible();
        await page.goto(`/rooms/${room.slug}`);
        await expect(page.locator("button[aria-controls^='values-']")).toHaveCount(30);
        await page.locator("button[aria-controls^='values-']").first().click();
        await expect(page.locator("[data-field-values]")).toHaveCount(2);
        await capture("hall-page");
        await page
          .getByRole("button", { name: t(locale, "fields.values.openAll"), exact: true })
          .click();
        await expect(page.locator("[data-field-values]")).toHaveCount(31);
        await checkWidth(page);
        await page
          .getByRole("button", { name: t(locale, "fields.values.closeAll"), exact: true })
          .click();
        await page
          .getByRole("button", { name: t(locale, "fields.values.more", { count: 2 }), exact: true })
          .click();
        await expect(page.getByText("Raumangabe 10", { exact: true })).toBeVisible();
        await capture("room-page");
        await page.goto(`/rooms/${room.slug}/edit`);
        await page.getByLabel(roomFields[0].name, { exact: true }).scrollIntoViewIfNeeded();
        await capture("room-form");
        await page.goto("/rooms/new");
        await page.getByLabel(roomFields[0].name, { exact: true }).scrollIntoViewIfNeeded();
        await capture("room-new");
        await page.goto("/inventory/new");
        await page.getByLabel(fields[0].name, { exact: true }).scrollIntoViewIfNeeded();
        await capture("device-new");
      }
    });
  }
