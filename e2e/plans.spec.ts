import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

test.describe.configure({ mode: "serial" });
const renders = "test-results/plans";
const rooms: string[] = [],
  devices: string[] = [],
  planIds: string[] = [];
let semesterPlan: string, electricalPlan: string;
const deviceName = "Synthetischer mobiler Projektor 33 · Sicherheitsprüfung";
const semesterName = "Synthetischer Semesterstart";

async function setDate(page: Page, ref: string, value: string) {
  await expect
    .poll(() =>
      page.evaluate(
        async ({ ref, value, modulePath }) => {
          const { uiAgent } = await import(modulePath);
          return (await uiAgent.act({ steps: [{ ref, action: "setValue", args: [value] }] })).ok;
        },
        { ref, value, modulePath: "/app/lib/ui-agent.client.ts" },
      ),
    )
    .toBe(true);
}

test.beforeAll(async () => {
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  for (let index = 0; index < 70; index++) {
    const room = await db.room.create({
      data: { name: `Synthetischer Raum ${index + 1}`, slug: `${runPrefix()}plan-room-${index}` },
    });
    rooms.push(room.id);
    const count = index === 0 ? 16 : 1;
    for (let deviceIndex = 0; deviceIndex < count; deviceIndex++) {
      const device = await db.equipment.create({
        data: {
          roomId: room.id,
          kindId: kind.id,
          category: "PROJECTOR",
          mobility: index === 0 ? "POOLED" : "FIXED",
          name:
            index === 0 && deviceIndex === 0
              ? deviceName
              : `Synthetisches Gerät ${index + 1}-${deviceIndex + 1} mit absichtlich langer Bezeichnung für die Darstellung`,
        },
      });
      devices.push(device.id);
    }
  }
  for (let index = 0; index < 120; index++) {
    const device = await db.equipment.create({
      data: {
        name: `Synthetisches Poolgerät ${String(index + 1).padStart(3, "0")}`,
        kindId: kind.id,
        category: "PROJECTOR",
        mobility: "POOLED",
      },
    });
    devices.push(device.id);
  }
  mkdirSync(renders, { recursive: true });
});

test.afterAll(async () => {
  const fields = await db.workPlan.findMany({
    where: { id: { in: planIds } },
    select: { fieldId: true },
  });
  await db.$executeRaw`TRUNCATE "EquipmentReading"`;
  await db.round.deleteMany({ where: { planId: { in: planIds } } });
  await db.workPlan.deleteMany({ where: { id: { in: planIds } } });
  await db.customField.deleteMany({
    where: { id: { in: fields.flatMap((row) => (row.fieldId ? [row.fieldId] : [])) } },
  });
  await db.semesterStart.deleteMany({ where: { name: semesterName } });
  await db.equipment.deleteMany({ where: { id: { in: devices } } });
  await db.room.deleteMany({ where: { id: { in: rooms } } });
  await db.$disconnect();
});

test("enabling sourced defaults schedules calendar and home work, then a passed device inspection advances its own date", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "locale", value: "de", url: baseURL! }]);
  await page.goto("/plans");
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(
    page.getByRole("form", { name: "Rundgang vor Semesterbeginn", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("form", { name: "Rundgang vor Semesterbeginn", exact: true })
    .getByRole("button", { name: "Einschalten", exact: true })
    .click();
  await expect(page).toHaveURL(/\/plans\/[^/]+$/);
  semesterPlan = page.url().split("/").at(-1)!;
  planIds.push(semesterPlan);
  await page.getByRole("button", { name: "Plan bearbeiten", exact: true }).click();
  await setDate(page, "Erstmals fällig / Semesterstarts ab", "2024-01-01");
  await page.getByRole("button", { name: "Plan speichern", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Rundgang vor Semesterbeginn", exact: true }),
  ).toBeVisible();
  const semester = page.getByRole("form", { name: "Semesterstart speichern", exact: true });
  await semester
    .getByRole("textbox", { name: "Bezeichnung des Semesters", exact: true })
    .fill(semesterName);
  await setDate(page, "Semesterbeginn", "2025-04-01");
  await semester.getByRole("button", { name: "Semesterstart speichern", exact: true }).click();
  await expect(page.getByText(semesterName, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Rundgang starten/ })).toBeVisible();
  await page.goto("/plans");
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await page
    .getByRole("form", { name: "Elektroprüfung ortsveränderlicher Geräte", exact: true })
    .getByRole("button", { name: "Einschalten", exact: true })
    .click();
  await expect(page).toHaveURL(/\/plans\/[^/]+$/);
  electricalPlan = page.url().split("/").at(-1)!;
  planIds.push(electricalPlan);
  await page.getByRole("button", { name: "Weitere Geräte", exact: true }).click();
  await expect(page.getByText("51–100 von 136", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Vorherige Geräte", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Aktuelle Prüfnorm bei der DKE", exact: true }),
  ).toHaveAttribute("href", /dke\.de/);
  await page.getByRole("button", { name: "Plan bearbeiten", exact: true }).click();
  await setDate(page, "Erstmals fällig / Semesterstarts ab", "2025-03-31");
  await page.getByRole("button", { name: "Plan speichern", exact: true }).click();
  await expect(
    page.getByRole("link", {
      name: `Elektroprüfung ortsveränderlicher Geräte · ${deviceName}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.goto(`/calendar?view=day&date=2025-03-31&kinds=plans&room=${rooms[0]}`);
  await expect(
    page.getByRole("link", { name: /Rundgang vor Semesterbeginn/ }).first(),
  ).toBeVisible();
  await expect(
    page
      .getByRole("link", { name: /Elektroprüfung ortsveränderlicher Geräte · 16 Geräte/ })
      .first(),
  ).toBeVisible();
  await page.screenshot({ path: `${renders}/calendar-de.png` });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Rundgang vor Semesterbeginn", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Elektroprüfung ortsveränderlicher Geräte/ }).first(),
  ).toBeVisible();
  await page.screenshot({ path: `${renders}/home-de.png` });
  await page.goto(`/plans/${electricalPlan}?device=${devices[0]}`);
  await expect(page.getByRole("heading", { name: deviceName, exact: true })).toBeVisible();
  await setDate(page, "Prüfdatum", "2025-03-31");
  await page
    .getByRole("textbox", { name: "Prüfbericht / Quelle", exact: true })
    .fill("Synthetischer Prüfbericht 101");
  await page.getByRole("button", { name: "Prüfung speichern", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Gespeichert.");
  await expect(page.locator("[data-next-due]")).toContainText("30.09.2025");
  const reading = await db.equipmentReading.findFirstOrThrow({
    where: { equipmentId: devices[0], planId: electricalPlan },
  });
  expect(reading).toMatchObject({
    value: true,
    sourceRef: "Synthetischer Prüfbericht 101",
    observedAt: new Date("2025-03-30T22:00:00Z"),
  });
  await expect(
    page.getByText("Zuletzt geprüft: 31.03.2025 · Bestanden", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${renders}/inspection-de.png` });
  await page.goto(`/calendar?view=day&date=2025-09-30&kinds=plans&equipment=${devices[0]}`);
  await expect(page.getByRole("link", { name: new RegExp(deviceName) })).toBeVisible();
  await page.goto(`/calendar?view=day&date=2025-03-31&kinds=plans&equipment=${devices[0]}`);
  await expect(page.getByRole("link", { name: new RegExp(deviceName) })).toHaveCount(0);
  expect(
    await db.equipmentReading.count({ where: { equipmentId: devices[1], planId: electricalPlan } }),
  ).toBe(0);
  await page.goto(`/plans/${semesterPlan}`);
  await page.getByRole("button", { name: /Rundgang starten/ }).click();
  await expect(page).toHaveURL(/\/rounds\//);
  const round = await db.round.findUniqueOrThrow({
    where: { id: page.url().split("/").at(-1)! },
    include: { rooms: true },
  });
  expect(round.planId).toBe(semesterPlan);
  expect(round.rooms.filter((row) => rooms.includes(row.roomId))).toHaveLength(70);
});

for (const locale of ["de", "en"] as const)
  for (const density of ["comfortable", "compact"] as const)
    test(`recurring work fits both widths in ${locale} ${density}`, async ({ page, baseURL }) => {
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);
      for (const width of [1280, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const [name, path] of [
          ["plans", "/plans"],
          ["inspection", `/plans/${electricalPlan}?device=${devices[0]}`],
          ["round", `/plans/${semesterPlan}`],
          ["home", "/"],
          ["calendar", `/calendar?view=day&date=2025-03-31&kinds=plans&room=${rooms[0]}`],
        ]) {
          await page.goto(path);
          await expect(page.locator("aside").first()).toBeVisible();
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          await page.screenshot({ path: `${renders}/${name}-${width}-${locale}-${density}.png` });
        }
      }
    });

test("the phone keeps the inspection source, keyboard focus and dated result", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "locale", value: "de", url: baseURL! }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/m/plans/${electricalPlan}?device=${devices[0]}`);
  await expect(page.getByRole("heading", { name: deviceName, exact: true })).toBeVisible();
  await expect(page.locator("[data-next-due]")).toContainText("30.09.2025");
  await page.getByRole("textbox", { name: "Prüfbericht / Quelle", exact: true }).focus();
  await expect(
    page.getByRole("textbox", { name: "Prüfbericht / Quelle", exact: true }),
  ).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${renders}/phone-inspection.png` });
  await page.getByRole("link", { name: t("de", "readings.history"), exact: true }).click();
  await expect(page.getByText("Synthetischer Prüfbericht 101", { exact: false })).toBeVisible();
});
