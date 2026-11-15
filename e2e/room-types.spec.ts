import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { categoryForKind } from "~/lib/equipment-kinds/kinds.server";
import { runPrefix } from "./run";

test.describe.configure({ mode: "serial" });
const ids: string[] = [];
const evidence = "test-results/room-types";
let slug: string;
let roomId: string;
let recordingId: string;
let pictureId: string;

test.beforeAll(async () => {
  const prefix = `${runPrefix()}types`;
  const rooms = await db.room.createManyAndReturn({
    data: Array.from({ length: 70 }, (_, index) => ({
      name:
        index === 32
          ? "Hörsaal 33"
          : `Synthetic room ${prefix} ${index + 1} with a long descriptive name`,
      slug: `${prefix}-${index + 1}`,
      roomNumber: String(index + 1),
    })),
  });
  ids.push(...rooms.map((room) => room.id));
  const target = rooms.find((room) => room.roomNumber === "33")!;
  slug = target.slug;
  roomId = target.id;
  const keys = [
    "projector",
    "projector",
    "computer",
    "computer",
    "computer",
    "computer",
    "microphone",
    "microphone",
    "microphone",
    "microphone",
    "control_processor",
    "remote",
    "other",
    "other",
    "other",
    "other",
  ];
  const kinds = await db.equipmentKind.findMany();
  await db.equipment.createMany({
    data: keys.map((key, index) => {
      const kind = kinds.find((kind) => kind.systemKey === key)!;
      return {
        roomId,
        kindId: kind.id,
        category: categoryForKind(key),
        name: `Synthetic ${key} ${index + 1}`,
      };
    }),
  });
  recordingId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "recording" } })).id;
  pictureId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } })).id;
  mkdirSync(evidence, { recursive: true });
});

test.afterAll(async () => {
  const scopes = await db.roundRoom.findMany({ where: { roomId: { in: ids } } });
  await db.round.deleteMany({ where: { id: { in: scopes.map((row) => row.roundId) } } });
  await db.roomCheck.deleteMany({ where: { roomId: { in: ids } } });
  await db.functionOverride.deleteMany({ where: { roomId: { in: ids } } });
  await db.ticket.deleteMany({ where: { roomId: { in: ids } } });
  await db.equipment.deleteMany({ where: { roomId: { in: ids } } });
  await db.room.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

test("assigning a room type shows missing functions without inventing faults", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/rooms/${slug}/edit`);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  const type = page.getByRole("combobox", { name: "Raumtyp", exact: true });
  await type.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("option", { name: "Hörsaal", exact: true }).click();
  await expect(page.locator('input[name="roomTypeId"]')).not.toHaveValue("none");
  await expect(page.getByText(/Erwartet:.*Aufzeichnung/)).toBeVisible();
  await page.getByRole("button", { name: t("de", "rooms.edit.submit"), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${slug}$`));
  const gap = page.locator(`#function-${recordingId}`);
  await expect(gap.getByText("Fehlt", { exact: true })).toBeVisible();
  await expect(gap.getByText(t("de", "functions.missing"))).toBeVisible();
  expect(await db.ticket.count({ where: { roomId } })).toBe(0);
  await page.goto(`/functions?functionId=${recordingId}`);
  await expect(page.getByRole("link", { name: "Hörsaal 33", exact: true })).toHaveCount(0);
  await page.goto(`/m/rooms/${slug}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.locator(`#function-${recordingId}`).getByText("Fehlt", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${evidence}/phone-gaps.png`, fullPage: true });
});

test("room types, expected functions and room selection fit both languages and densities", async ({
  page,
  baseURL,
}) => {
  for (const locale of ["de", "en"] as const)
    for (const density of ["comfortable", "compact"]) {
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);
      for (const width of [1280, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const route of [`/rooms/${slug}`, `/rooms/${slug}/edit`, "/rooms"]) {
          await page.goto(route);
          await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          if (route.endsWith("/edit")) {
            await expect(
              page.getByRole("combobox", { name: t(locale, "functions.types.label"), exact: true }),
            ).toBeVisible();
          }
          if (route === "/rooms" && width === 1920) {
            const name = await page
              .locator('[role="columnheader"][data-column-id="name"]')
              .boundingBox();
            expect(name!.width).toBeGreaterThan(250);
            await expect(
              page.locator('[role="cell"][data-column-id="name"]').first().getByRole("checkbox"),
            ).toBeVisible();
          }
          if (locale === "de" && density === "comfortable") {
            if (width === 1280 && route === `/rooms/${slug}`)
              await page.screenshot({ path: `${evidence}/hall-gaps.png`, fullPage: true });
            if (width === 1280 && route.endsWith("/edit"))
              await page.screenshot({ path: `${evidence}/room-type-form.png`, fullPage: true });
            if (width === 1920 && route === "/rooms")
              await page.screenshot({ path: `${evidence}/room-selection.png`, fullPage: true });
          }
        }
      }
    }
});

test("a small room adjustment drops an expectation with its reason and dual-writes the old flag", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([
    { name: "locale", value: "de", url: baseURL! },
    { name: "view", value: "desktop", url: baseURL! },
  ]);
  await page.goto(`/rooms/${slug}/edit`);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("button", { name: "Für diesen Raum anpassen", exact: true }).click();
  await page.getByRole("combobox", { name: "Aufzeichnung", exact: true }).click();
  await page.getByRole("option", { name: "Hier nicht vorgesehen", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Begründung für Aufzeichnung (optional)", exact: true })
    .fill("Synthetic intentional omission");
  await page.getByRole("button", { name: t("de", "rooms.edit.submit"), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${slug}$`));
  await expect(page.locator(`#function-${recordingId}`)).toHaveCount(0);
  expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).hasAutoRecording).toBe(false);
  expect(
    await db.roomFunctionExpectation.findUnique({
      where: { roomId_functionId: { roomId, functionId: recordingId } },
    }),
  ).toMatchObject({ expected: false, note: "Synthetic intentional omission" });
});

test("five selected rooms can receive a type without changing their existing adjustments", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([
    { name: "locale", value: "de", url: baseURL! },
    { name: "view", value: "desktop", url: baseURL! },
  ]);
  await page.goto("/rooms");
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  const selected = await db.room.findMany({ where: { id: { in: ids.slice(0, 5) } } });
  for (const room of selected)
    await page
      .getByRole("checkbox", {
        name: t("de", "functions.types.select", { name: room.name }),
        exact: true,
      })
      .check();
  const form = page.getByRole("form", { name: "Raumtyp zuweisen", exact: true });
  await expect(form.getByText("5 Räume ausgewählt", { exact: true })).toBeVisible();
  await form.getByRole("combobox", { name: "Raumtyp", exact: true }).click();
  await page
    .getByRole("option", { name: "Saal (Veranstaltungs- / Festsaal)", exact: true })
    .click();
  await form.getByRole("button", { name: "Raumtyp zuweisen", exact: true }).click();
  await expect(form.getByRole("status")).toHaveText("Raumtyp gespeichert");
  await page.setViewportSize({ width: 1920, height: 1000 });
  await page.screenshot({ path: `${evidence}/room-selection.png`, fullPage: true });
  expect(
    (await db.room.findMany({ where: { id: { in: selected.map((room) => room.id) } } })).every(
      (room) => room.roomTypeId,
    ),
  ).toBe(true);
  expect(await db.ticket.count({ where: { roomId: { in: ids } } })).toBe(0);
});

test("expected gaps stay visible and a round finishes without invented checks after retirement", async ({
  page,
  baseURL,
}) => {
  const room = await db.room.findUniqueOrThrow({ where: { id: roomId } });
  const round = await db.round.create({
    data: { name: "Synthetic retirement round", rooms: { create: { roomId } } },
  });
  await db.equipment.updateMany({
    where: { roomId },
    data: { status: "RETIRED" },
  });
  await page.context().addCookies([
    { name: "locale", value: "de", url: baseURL! },
    { name: "view", value: "mobile", url: baseURL! },
  ]);
  await page.goto(`/m/rounds/${round.id}/${room.id}`);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("heading", { name: "Projektion", exact: true })).toBeVisible();
  const section = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Projektion", exact: true }) });
  await expect(section.getByRole("button")).toHaveCount(0);
  await expect(section.getByText(t("de", "functions.missing"), { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: t("de", "functions.rounds.finishEmpty"), exact: true })
    .click();
  await expect(
    page.getByText(t("de", "functions.rounds.progress", { done: 1, total: 1 }), { exact: true }),
  ).toBeVisible();
  expect(
    await db.roomCheck.count({
      where: { roundId: round.id, functionId: pictureId, result: "WORKS" },
    }),
  ).toBe(0);
  expect(await db.ticket.count({ where: { roomId } })).toBe(0);
});

test("SDK agents can find and change the room type and its per-room adjustment", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([
    { name: "locale", value: "de", url: baseURL! },
    { name: "view", value: "desktop", url: baseURL! },
  ]);
  await page.goto(`/rooms/${slug}/edit`);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  const type = await db.roomType.findUniqueOrThrow({ where: { systemKey: "lecture_hall" } });
  const labels = await page.evaluate(
    async ({ id, modulePath }) => {
      const { uiAgent: agent } = await import(modulePath);
      const labels = agent
        .snapshot()
        .filter((entry: { offPage?: boolean }) => !entry.offPage)
        .map((entry: { label: string }) => entry.label);
      const result = await agent.act({
        steps: [
          { ref: "Raumtyp", action: "setValue", args: [id] },
          { ref: "Für diesen Raum anpassen", action: "setOpen", args: [true] },
        ],
      });
      if (!result.ok) throw new Error(result.error?.message);
      return labels;
    },
    { id: type.id, modulePath: "/app/lib/ui-agent.client.ts" },
  );
  expect(labels).toContain("Raumtyp");
  expect(labels.every(Boolean)).toBe(true);
  await expect(page.getByRole("combobox", { name: "Projektion", exact: true })).toBeVisible();
  await page.evaluate(async (modulePath) => {
    const { uiAgent } = await import(modulePath);
    const result = await uiAgent.act({
      steps: [{ ref: "Projektion", action: "setValue", args: ["no"] }],
    });
    if (!result.ok) throw new Error(result.error?.message);
  }, "/app/lib/ui-agent.client.ts");
  await expect(
    page.getByRole("textbox", { name: "Begründung für Projektion (optional)", exact: true }),
  ).toBeVisible();
});
