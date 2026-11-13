import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { categoryForKind } from "~/lib/equipment-kinds/kinds.server";
import { runPrefix } from "./run";
import sharp from "sharp";

test.describe.configure({ mode: "serial" });

const roomIds: string[] = [];
const evidence = "test-results/rounds";
let buildingId: string;
let campusId: string;
let roomId: string;
let slug: string;
let roundId: string;
let buildingName: string;
let pictureId: string;

test.beforeAll(async () => {
  const prefix = `${runPrefix()}rounds`;
  const campus = await db.campus.create({
    data: { name: "Synthetic round campus", slug: `${prefix}-campus` },
  });
  campusId = campus.id;
  buildingName = `${prefix} building`;
  buildingId = (await db.building.create({ data: { name: buildingName, campusId } })).id;
  const rooms = await db.room.createManyAndReturn({
    data: Array.from({ length: 70 }, (_, index) => ({
      name:
        index === 32 ? "Hörsaal 33" : `Synthetic room ${index + 1} with a long descriptive name`,
      roomNumber: String(index + 1),
      slug: `${prefix}-${index + 1}`,
      campusId,
      buildingId,
    })),
  });
  roomIds.push(...rooms.map((row) => row.id));
  const target = rooms.find((row) => row.roomNumber === "33")!;
  roomId = target.id;
  slug = target.slug;
  const kinds = await db.equipmentKind.findMany({
    where: {
      systemKey: { in: ["projector", "microphone", "computer", "control_processor", "recorder"] },
    },
  });
  await db.equipment.createMany({
    data: Array.from({ length: 213 }, (_, index) => {
      const kind = kinds[index % kinds.length];
      return {
        roomId:
          index < 16 ? roomId : rooms.filter((room) => room.id !== roomId)[(index - 16) % 69].id,
        kindId: kind.id,
        category: categoryForKind(kind.systemKey),
        name: `Synthetic device ${index + 1}`,
        statusSince: new Date("2020-01-01T00:00:00Z"),
      };
    }),
  });
  pictureId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } })).id;
  mkdirSync(evidence, { recursive: true });
});
test.afterAll(async () => {
  const scopes = await db.roundRoom.findMany({
    where: { roomId: { in: roomIds } },
    select: { roundId: true },
  });
  await db.round.deleteMany({ where: { id: { in: scopes.map((row) => row.roundId) } } });
  await db.roomCheck.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.functionOverride.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.attachment.deleteMany({
    where: { OR: [{ roomId: { in: roomIds } }, { ticket: { roomId: { in: roomIds } } }] },
  });
  await db.ticket.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.building.delete({ where: { id: buildingId } });
  await db.campus.delete({ where: { id: campusId } });
  await db.$disconnect();
});

test("starts a selected round, checks the room on a phone within two minutes and exposes its fault", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120_000);
  await page.context().addCookies([{ name: "view", value: "mobile", url: baseURL! }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/m/rounds");
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  await page.getByLabel(t("de", "functions.list.building")).selectOption(buildingName);
  await expect(page.locator('input[name="roomIds"]')).toHaveCount(70);
  const roundsBeforeSelection = await db.round.count();
  const none = page.getByRole("button", { name: t("de", "functions.rounds.none"), exact: true });
  const all = page.getByRole("button", { name: t("de", "functions.rounds.all"), exact: true });
  await expect(none).toHaveAttribute("type", "button");
  await expect(all).toHaveAttribute("type", "button");
  await none.click();
  await expect(page.locator('input[name="roomIds"]')).toHaveCount(0);
  await all.click();
  await expect(page.locator('input[name="roomIds"]')).toHaveCount(70);
  await expect(page).toHaveURL(/\/m\/rounds$/);
  expect(await db.round.count()).toBe(roundsBeforeSelection);
  await page.getByLabel(t("de", "functions.rounds.name")).fill("Synthetic semester round");
  await page.getByRole("button", { name: t("de", "functions.rounds.start"), exact: true }).click();
  await expect(page).toHaveURL(/\/m\/rounds\/[^/]+$/);
  roundId = page.url().split("/").at(-1)!;
  await page.getByRole("link", { name: "Hörsaal 33", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hörsaal 33");
  await expect(page).toHaveTitle(t("de", "functions.rounds.checkMeta", { name: "Hörsaal 33" }));
  await expect(page.getByRole("region")).toHaveCount(5);
  const started = Date.now();
  const sections = page.getByRole("region");
  const sound = sections.filter({
    has: page.getByRole("heading", { name: "Ton und Mikrofone", exact: true }),
  });
  await sound.getByText(t("de", "functions.rounds.notePhoto"), { exact: true }).click();
  await sound.getByLabel(t("de", "functions.note")).fill("Synthetic microphone fault");
  const photo = await sharp({ create: { width: 16, height: 16, channels: 3, background: "white" } })
    .withExif({ IFD0: { Artist: "Synthetic technician" } })
    .jpeg()
    .toBuffer();
  await sound
    .locator('input[type="file"]')
    .setInputFiles({ name: "synthetic-round.jpg", mimeType: "image/jpeg", buffer: photo });
  await sound.getByRole("button", { name: t("de", "functions.state.DOWN"), exact: true }).click();
  await expect(sound.getByText(new RegExp(t("de", "functions.rounds.saved")))).toBeVisible();
  await expect(
    sound.getByText(t("de", "mobile.entry.uploading"), { exact: true }),
  ).not.toBeVisible();
  const fault = await db.ticket.findFirstOrThrow({
    where: { roomId, channel: "ROUND", impact: "DOWN" },
  });
  await expect.poll(() => db.attachment.count({ where: { ticketId: fault.id } })).toBe(1);
  const attachment = await db.attachment.findFirstOrThrow({ where: { ticketId: fault.id } });
  const served = await page.request.get(`/attachments/${attachment.objectKey}`);
  expect(served.ok()).toBe(true);
  expect((await sharp(await served.body()).metadata()).exif).toBeUndefined();
  for (const section of await sections.all()) {
    const works = section.getByRole("button", {
      name: t("de", "functions.state.WORKS"),
      exact: true,
    });
    if (await works.count()) {
      await works.click();
      await expect(section.getByRole("status")).toContainText(t("de", "functions.rounds.saved"));
    }
  }
  expect(Date.now() - started).toBeLessThan(120_000);
  await expect(
    page.getByText(t("de", "functions.rounds.progress", { done: 1, total: 70 }), { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: `${evidence}/phone-check.png`, fullPage: true });
  await page.getByRole("link", { name: t("de", "functions.back"), exact: true }).click();
  const functions = page.getByRole("region", { name: t("de", "functions.title"), exact: true });
  await expect(functions.getByText(t("de", "functions.state.WORKS"), { exact: true })).toHaveCount(
    4,
  );
  await expect(
    functions
      .getByText(t("de", "functions.state.WORKS"), { exact: true })
      .locator(".bg-status-operational"),
  ).toHaveCount(4);
  await page.goto(`/m/functions?buildingId=${buildingId}`);
  await expect(page.getByText("Hörsaal 33", { exact: true })).toBeVisible();
  expect(await db.ticket.count({ where: { roomId, channel: "ROUND", impact: "DOWN" } })).toBe(1);
  await page.goto(`/m/rounds/${roundId}`);
  await page.getByRole("link", { name: t("de", "functions.rounds.next"), exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Synthetic room 1 ");
  for (const section of await page.getByRole("region").all()) {
    await section
      .getByRole("button", { name: t("de", "functions.state.WORKS"), exact: true })
      .click();
    await expect(section.getByRole("status")).toContainText(t("de", "functions.rounds.saved"));
  }
  await expect(
    page.getByText(t("de", "functions.rounds.progress", { done: 2, total: 70 }), { exact: true }),
  ).toBeVisible();
});

test("round lists, progress and green rooms fit both languages and densities with the sidebar open", async ({
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
      for (const path of ["/rounds", `/rounds/${roundId}`, `/rooms/${slug}`]) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (path.endsWith(roundId)) {
          await expect(
            page.getByText(t(locale, "functions.rounds.progress", { done: 2, total: 70 }), {
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            page.getByRole("heading", { name: t(locale, "functions.rounds.faults") }),
          ).toBeVisible({ timeout: 10_000 });
          if (locale === "de" && density === "comfortable")
            await page.screenshot({ path: `${evidence}/progress-1280.png` });
        }
        if (path.includes("/rooms/")) {
          const block = page.getByRole("region", {
            name: t(locale, "functions.title"),
            exact: true,
          });
          await expect(
            block.getByText(t(locale, "functions.state.WORKS"), { exact: true }),
          ).toHaveCount(4);
          if (locale === "de" && density === "comfortable")
            await block.screenshot({ path: `${evidence}/confirmed-functions.png` });
        }
        await page.setViewportSize({ width: 1920, height: 1080 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
});

test("admin can set and clear a state through the keyboard accessible dialog", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([
    { name: "view", value: "desktop", url: baseURL! },
    { name: "locale", value: "de", url: baseURL! },
  ]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/rooms/${slug}`);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  const picture = page.locator(`#function-${pictureId}`);
  const trigger = picture.getByRole("button", {
    name: t("de", "functions.override.title"),
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: t("de", "functions.override.title"),
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(t("de", "functions.list.state")).selectOption("LIMITED");
  await dialog
    .getByLabel(t("de", "functions.override.reason"))
    .fill("Synthetic intermittent signal");
  await page.screenshot({ path: `${evidence}/manual-state.png` });
  await dialog.getByRole("button", { name: t("de", "common.save"), exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    picture.getByText(t("de", "functions.state.LIMITED"), { exact: true }),
  ).toBeVisible();
  await expect(
    picture.getByText(t("de", "functions.manual", { reason: "Synthetic intermittent signal" }), {
      exact: true,
    }),
  ).toBeVisible();
  await trigger.click();
  await dialog
    .getByRole("button", { name: t("de", "functions.override.clear"), exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(picture.getByText(t("de", "functions.state.WORKS"), { exact: true })).toBeVisible();
  await expect(trigger).toBeFocused();
});

test("a passing recheck explicitly resolves the fault and restores its device", async ({
  page,
  baseURL,
}) => {
  const device = await db.equipment.findFirstOrThrow({
    where: { roomId, kind: { systemKey: "microphone" } },
  });
  await db.equipment.update({
    where: { id: device.id },
    data: { status: "FAULTY", statusSince: new Date() },
  });
  await page.context().addCookies([{ name: "view", value: "mobile", url: baseURL! }]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/m/rounds");
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("button", { name: t("de", "functions.rounds.none"), exact: true }).click();
  await page.getByRole("checkbox", { name: /^Hörsaal 33/ }).check();
  await page.getByLabel(t("de", "functions.rounds.name")).fill("Synthetic recheck");
  await page.getByRole("button", { name: t("de", "functions.rounds.start"), exact: true }).click();
  await page.getByRole("link", { name: "Hörsaal 33", exact: true }).click();
  const sound = page.getByRole("region", { name: "Ton und Mikrofone", exact: true });
  await sound.getByRole("button", { name: t("de", "functions.state.WORKS"), exact: true }).click();
  await expect(
    sound.getByText(t("de", "functions.rounds.conflict"), { exact: true }),
  ).toBeVisible();
  await sound.getByRole("checkbox", { name: /^Störung lösen:/ }).check();
  await sound.getByRole("checkbox", { name: /^Wieder betriebsbereit setzen:/ }).check();
  await sound.getByLabel(t("de", "functions.fixes.helped")).fill("Synthetic cable repair");
  await sound.getByRole("button", { name: t("de", "common.save"), exact: true }).click();
  await expect(sound.getByRole("status")).toHaveText(
    `${t("de", "functions.rounds.saved")} · ${t("de", "functions.state.WORKS")}`,
  );
  expect((await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).status).toBe(
    "OPERATIONAL",
  );
  expect(
    await db.ticket.count({
      where: { roomId, status: "RESOLVED", keepAsFix: true, resolution: "Synthetic cable repair" },
    }),
  ).toBe(1);
  await page.getByRole("link", { name: t("de", "functions.back"), exact: true }).click();
  const block = page.getByRole("region", { name: t("de", "functions.title"), exact: true });
  await expect(block.getByText(t("de", "functions.state.WORKS"), { exact: true })).toHaveCount(5);
});
