import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";
import { categoryForKind } from "~/lib/equipment-kinds/kinds.server";

const roomIds: string[] = [];
let slug: string;
let roomId: string;
let soundId: string;
const evidence = "test-results/room-functions";

test.beforeAll(async () => {
  const prefix = `${runPrefix()}functions`;
  slug = `${prefix}-33`;
  const rooms = await db.room.createManyAndReturn({
    data: Array.from({ length: 70 }, (_, index) => ({
      name: index === 32 ? "Hörsaal 33" : `Synthetic hall ${index + 1}`,
      roomNumber: String(index + 1),
      slug: index === 32 ? slug : `${prefix}-${index + 1}`,
    })),
  });
  roomIds.push(...rooms.map((room) => room.id));
  roomId = rooms.find((room) => room.slug === slug)!.id;
  const kinds = await db.equipmentKind.findMany({
    where: {
      systemKey: {
        in: [
          "projector",
          "interactive_display",
          "computer",
          "presentation_switcher",
          "microphone",
          "audio_equipment",
          "control_processor",
          "remote",
          "recorder",
          "other",
        ],
      },
    },
  });
  expect(kinds).toHaveLength(10);
  const targetKeys = [
    "projector",
    "projector",
    "interactive_display",
    "computer",
    "presentation_switcher",
    "microphone",
    "microphone",
    "microphone",
    "audio_equipment",
    "audio_equipment",
    "control_processor",
    "remote",
    "recorder",
    "other",
    "other",
    "other",
  ];
  const others = rooms.filter((room) => room.id !== roomId);
  await db.equipment.createMany({
    data: Array.from({ length: 213 }, (_, index) => {
      const key = targetKeys[index];
      const kind =
        index < 16 ? kinds.find((kind) => kind.systemKey === key)! : kinds[index % kinds.length];
      return {
        roomId: index < 16 ? roomId : others[(index - 16) % others.length].id,
        kindId: kind.id,
        category: categoryForKind(kind.systemKey),
        name: index < 16 ? `Synthetic ${key} ${index + 1}` : `Synthetic device ${index + 1}`,
        statusSince: new Date("2040-01-01T00:00:00Z"),
      };
    }),
  });
  soundId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "sound" } })).id;
  mkdirSync(evidence, { recursive: true });
});
test.afterAll(async () => {
  await db.ticket.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.$disconnect();
});

test("a room's functions and their devices fit both desktop densities and languages", async ({
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
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/rooms/${slug}`);
      await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
      const block = page.getByRole("region", { name: t(locale, "functions.title"), exact: true });
      await expect(block.getByRole("heading", { level: 3 })).toHaveCount(5);
      await expect(
        block.getByText(t(locale, "functions.state.NO_KNOWN_FAULT"), { exact: true }),
      ).toHaveCount(5);
      await expect(block.getByText("Synthetic projector 1", { exact: true })).toBeVisible();
      await expect(
        block.locator(`#function-${soundId}`).getByText("Synthetic microphone 6", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: t(locale, "functions.report"), exact: true }),
      ).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (locale === "de" && density === "comfortable")
        await page.screenshot({ path: `${evidence}/desktop.png`, fullPage: true });
      await page.setViewportSize({ width: 1920, height: 1080 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  await page.getByRole("button", { name: t("en", "functions.report"), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/m/tickets/new\\?roomId=${roomId}`));
  await expect(
    page.getByRole("radio", { name: "Sound and microphones", exact: true }),
  ).toBeVisible();
});

test("a phone fault takes under 30 seconds and updates the room live", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.context().addCookies([
    { name: "locale", value: "de", url: baseURL! },
    { name: "view", value: "mobile", url: baseURL! },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/m/rooms/${slug}`);
  await expect(page.getByRole("heading", { name: "Hörsaal 33", exact: true })).toBeVisible();
  const desktop = await browser.newContext({
    storageState: "e2e/.auth/admin.json",
    baseURL,
    viewport: { width: 1280, height: 900 },
  });
  await desktop.addCookies([
    { name: "view", value: "desktop", url: baseURL! },
    { name: "locale", value: "de", url: baseURL! },
  ]);
  const observer = await desktop.newPage();
  await observer.goto(`/rooms/${slug}`);
  const started = performance.now();
  await page.getByRole("link", { name: "Störung melden", exact: true }).click();
  await page.getByRole("radio", { name: "Ton und Mikrofone", exact: true }).check();
  await page.getByRole("radio", { name: "Geht nicht", exact: true }).check();
  await page.screenshot({ path: `${evidence}/phone-form.png`, fullPage: true });
  await page.getByRole("button", { name: t("de", "mobile.entry.submit"), exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/m/rooms/${slug}`));
  const row = page.locator(`#function-${soundId}`);
  await expect(row.getByText("Geht nicht", { exact: true })).toBeVisible();
  expect(performance.now() - started).toBeLessThan(30_000);
  await expect(
    observer.locator(`#function-${soundId}`).getByText("Geht nicht", { exact: true }),
  ).toBeVisible();
  const fault = await db.ticket.findFirstOrThrow({
    where: { roomId, functionId: soundId, impact: "DOWN" },
  });
  expect(fault.channel).toBe("PHONE");
  expect(fault.title).toBe("Ton und Mikrofone: Geht nicht");
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `${evidence}/phone-room.png`, fullPage: true });
  await desktop.close();
});

test("offline reporting keeps the form and never pretends to save", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: "view", value: "mobile", url: baseURL! }]);
  await page.goto(`/m/tickets/new?roomId=${roomId}`);
  await page.getByRole("radio", { name: "Ton und Mikrofone", exact: true }).check();
  await page.getByRole("radio", { name: "Eingeschränkt", exact: true }).check();
  await page
    .getByRole("textbox", { name: t("de", "functions.note") })
    .fill("Synthetic offline note");
  await context.setOffline(true);
  await expect(page.getByRole("alert")).toContainText("nicht gespeichert");
  await expect(
    page.getByRole("button", { name: t("de", "mobile.entry.submit"), exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("textbox", { name: t("de", "functions.note") })).toHaveValue(
    "Synthetic offline note",
  );
  await context.setOffline(false);
});

test("a hall keeps what helped, moves its earlier note once, and offers fixes on the next report", async ({
  page,
  baseURL,
}) => {
  const functionId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } }))
    .id;
  const ticket = await db.ticket.create({
    data: {
      title: "Synthetic picture stays black",
      type: "INCIDENT",
      roomId,
      functionId,
      impact: "DOWN",
    },
  });
  const note = "Synthetic earlier note:\nswitch HDMI to VGA and back.";
  const helped = "Synthetic input switched; picture restored.";
  await db.room.update({ where: { id: roomId }, data: { knownIssues: note } });
  await page.context().addCookies([
    { name: "locale", value: "de", url: baseURL! },
    { name: "view", value: "mobile", url: baseURL! },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/m/tickets/${ticket.id}`);
  await page.getByRole("textbox", { name: t("de", "functions.fixes.helped") }).fill(helped);
  await expect(page.getByRole("checkbox", { name: t("de", "functions.fixes.keep") })).toBeChecked();
  await page.screenshot({ path: `${evidence}/phone-resolve.png`, fullPage: true });
  await page.getByRole("button", { name: t("de", "tickets.detail.resolve"), exact: true }).click();
  await expect
    .poll(async () => (await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).keepAsFix)
    .toBe(true);
  await page.goto(`/m/rooms/${slug}`);
  const row = page.locator(`#function-${functionId}`);
  await row.getByText(t("de", "functions.fixes.count", { count: 1 }), { exact: true }).click();
  await expect(row.getByRole("paragraph").filter({ hasText: helped })).toBeVisible();
  await page.getByText(t("de", "functions.fixes.earlierNote"), { exact: true }).click();
  await page
    .getByRole("combobox", { name: t("de", "functions.list.function"), exact: true })
    .selectOption(functionId);
  await page.getByRole("button", { name: t("de", "functions.fixes.move"), exact: true }).click();
  await expect(
    row.getByText(t("de", "functions.fixes.count", { count: 2 }), { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await db.room.findUniqueOrThrow({ where: { id: roomId } })).knownIssues)
    .toBeNull();
  await expect(row.getByRole("paragraph").filter({ hasText: note })).toBeVisible();
  const moved = await db.ticket.findFirstOrThrow({
    where: { roomId, type: "REPAIR", resolution: note },
  });
  expect(
    await db.activityLog.count({
      where: { entityId: roomId, data: { path: ["knownIssuesMovedToTicketId"], equals: moved.id } },
    }),
  ).toBe(1);
  const replay = await page.request.post(`/rooms/${slug}/fixes`, {
    form: { intent: "move", functionId, note },
  });
  expect(replay.ok()).toBe(true);
  expect(await db.ticket.count({ where: { roomId, type: "REPAIR", resolution: note } })).toBe(1);
  await page.getByRole("link", { name: t("de", "functions.report"), exact: true }).click();
  await page.getByRole("radio", { name: "Projektion", exact: true }).check();
  await expect(page.getByText(helped, { exact: true })).toBeVisible();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  await page.screenshot({ path: `${evidence}/phone-known-fixes.png`, fullPage: true });

  for (const locale of ["de", "en"] as const)
    for (const density of ["comfortable", "compact"]) {
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
      ]);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/rooms/${slug}`);
      await row
        .getByText(t(locale, "functions.fixes.count", { count: 2 }), { exact: true })
        .click();
      await expect(row.getByRole("paragraph").filter({ hasText: helped })).toBeVisible();
      await expect(row.getByRole("paragraph").filter({ hasText: note })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (locale === "de" && density === "comfortable")
        await page.screenshot({ path: `${evidence}/hall-known-fixes.png`, fullPage: true });
      await page.setViewportSize({ width: 1920, height: 1080 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.goto(`/tickets/new?roomId=${roomId}`);
      await page
        .getByRole("combobox", { name: t(locale, "functions.list.function"), exact: true })
        .selectOption(functionId);
      await expect(page.getByText(helped, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  await page.goto(`/rooms/${slug}`);
  await row.getByText(t("en", "functions.fixes.count", { count: 2 }), { exact: true }).click();
  const fix = row.getByRole("listitem").filter({ hasText: "Synthetic picture stays black" });
  await fix.getByText(t("en", "functions.fixes.edit"), { exact: true }).click();
  await fix
    .getByRole("textbox", { name: t("en", "functions.fixes.helped") })
    .fill("Synthetic corrected fix");
  await fix.getByRole("button", { name: t("en", "common.save"), exact: true }).click();
  await expect(
    fix.getByRole("paragraph").filter({ hasText: "Synthetic corrected fix" }),
  ).toBeVisible();
  await fix.getByRole("button", { name: t("en", "functions.fixes.drop"), exact: true }).click();
  await expect(
    row.getByText(t("en", "functions.fixes.count", { count: 1 }), { exact: true }),
  ).toBeVisible();
  expect((await db.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).resolution).toBe(
    "Synthetic corrected fix",
  );
});
