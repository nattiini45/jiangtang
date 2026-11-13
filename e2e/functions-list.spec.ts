import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { transitionTicket } from "~/domains/tickets/tickets.mutations.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const roomIds: string[] = [];
const campusIds: string[] = [];
const buildingIds: string[] = [];
const evidence = "test-results/functions-list";
let pictureId: string;
let slug: string;
let faultId: string;

test.beforeAll(async () => {
  const prefix = `${runPrefix()}function-list`;
  for (let index = 0; index < 2; index++) {
    const campus = await db.campus.create({
      data: { name: `Synthetic campus ${index}`, slug: `${prefix}-campus-${index}` },
    });
    campusIds.push(campus.id);
    const building = await db.building.create({
      data: { name: `Synthetic building ${index}`, campusId: campus.id },
    });
    buildingIds.push(building.id);
  }
  const rooms = await db.room.createManyAndReturn({
    data: Array.from({ length: 70 }, (_, index) => ({
      name:
        index === 32
          ? "Hörsaal 33"
          : index < 58
            ? `Synthetic hall ${String(index + 1).padStart(2, "0")} with a long descriptive name`
            : `Synthetic room ${index + 1}`,
      roomNumber: String(index + 1),
      slug: `${prefix}-${index + 1}`,
      campusId: campusIds[index % 2],
      buildingId: buildingIds[index % 2],
    })),
  });
  rooms.sort((a, b) => Number(a.roomNumber) - Number(b.roomNumber));
  roomIds.push(...rooms.map((room) => room.id));
  slug = rooms[32].slug;
  const kinds = await db.equipmentKind.findMany({
    where: { systemKey: { in: ["projector", "microphone", "computer"] } },
  });
  await db.equipment.createMany({
    data: Array.from({ length: 213 }, (_, index) => ({
      roomId: roomIds[index % 70],
      kindId: kinds.find(
        (kind) =>
          kind.systemKey === (index < 70 ? "projector" : index < 140 ? "microphone" : "computer"),
      )!.id,
      category: index < 70 ? "PROJECTOR" : index < 140 ? "MICROPHONE" : "PC",
      name: `Synthetic device ${index + 1}`,
    })),
  });
  pictureId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } })).id;
  const soundId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "sound" } })).id;
  await db.ticket.createMany({
    data: Array.from({ length: 30 }, (_, index) => ({
      title: `Synthetic fault ${index + 1}`,
      type: "INCIDENT",
      roomId: roomIds[index],
      functionId: index % 2 ? soundId : pictureId,
      impact: index % 2 ? "DOWN" : "LIMITED",
      occurredAt: new Date(Date.UTC(2026, 0, index + 1)),
    })),
  });
  faultId = (
    await db.ticket.create({
      data: {
        title: "Synthetic projection fault in room 33",
        type: "INCIDENT",
        roomId: roomIds[32],
        functionId: pictureId,
        impact: "LIMITED",
        channel: "PHONE",
        occurredAt: new Date("2026-02-01T10:00:00Z"),
      },
    })
  ).id;
  mkdirSync(evidence, { recursive: true });
});

test.afterAll(async () => {
  await db.ticket.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.building.deleteMany({ where: { id: { in: buildingIds } } });
  await db.campus.deleteMany({ where: { id: { in: campusIds } } });
  await db.$disconnect();
});

test("finds the reported room fault, filters projection and sorts by age", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "view", value: "desktop", url: baseURL! }]);
  await page.goto(`/functions?campusId=${campusIds[0]}`);
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
  await page.getByRole("combobox", { name: "Funktion", exact: true }).selectOption(pictureId);
  await expect(page).toHaveURL(new RegExp(`functionId=${pictureId}`));
  await expect(page.getByRole("link", { name: "Hörsaal 33 · 33", exact: true })).toBeVisible();
  await page.getByRole("columnheader", { name: "Seit wann" }).getByRole("button").click();
  await expect(page.getByRole("columnheader", { name: "Seit wann" })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  await expect(page.getByRole("row").nth(1)).toContainText("Hörsaal 33");
  await page.getByRole("link", { name: "Hörsaal 33 · 33", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${slug}#function-${pictureId}`));
  await expect(page.locator(`#function-${pictureId}`)).toContainText(
    "Synthetic projection fault in room 33",
  );
  const heading = page
    .locator(`#function-${pictureId}`)
    .getByRole("heading", { name: "Projektion", exact: true });
  await expect
    .poll(async () => {
      const target = await heading.boundingBox();
      const header = await page.getByRole("banner").boundingBox();
      return target && header ? target.y >= header.y + header.height : false;
    })
    .toBe(true);
});

test("thirty rows fit the desktop in both languages and densities, and the phone uses the same list", async ({
  page,
  baseURL,
}) => {
  for (const locale of ["de", "en"] as const)
    for (const density of ["comfortable", "compact"]) {
      await page.context().addCookies([
        { name: "view", value: "desktop", url: baseURL! },
        { name: "locale", value: locale, url: baseURL! },
        { name: "density", value: density, url: baseURL! },
      ]);
      for (const width of [1280, 1920]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto("/functions");
        await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
        await page
          .getByRole("textbox", { name: t(locale, "common.dataGrid.filterLabel"), exact: true })
          .fill("Synthetic");
        await expect(page.getByRole("table")).toHaveAttribute("aria-rowcount", "32");
        expect(
          await page
            .getByRole("table")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: `${evidence}/${locale}-${density}-${width}.png`,
          fullPage: true,
        });
      }
    }
  await page.context().addCookies([
    { name: "view", value: "mobile", url: baseURL! },
    { name: "locale", value: "de", url: baseURL! },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/m/functions?functionId=${pictureId}&buildingId=${buildingIds[0]}&sort=newest`);
  await expect(page.getByRole("link", { name: /Hörsaal 33/ })).toBeVisible();
  await page.getByText(t("de", "functions.list.filters"), { exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Funktion", exact: true })).toHaveValue(
    pictureId,
  );
  await page.getByText(t("de", "functions.list.filters"), { exact: true }).click();
  await page.screenshot({ path: `${evidence}/phone.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("a desktop report shows its function on the detail and resolving refetches an open list", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "view", value: "desktop", url: baseURL! }]);
  await page.goto(`/tickets/new?roomId=${roomIds[32]}`);
  await page
    .getByRole("textbox", { name: t("de", "tickets.form.title"), exact: true })
    .fill("Synthetic desktop function fault");
  await page.getByRole("combobox", { name: "Funktion", exact: true }).selectOption(pictureId);
  await page.getByRole("combobox", { name: "Auswirkung", exact: true }).selectOption("DOWN");
  await page.getByRole("button", { name: t("de", "tickets.new.submit"), exact: true }).click();
  await expect(page).toHaveURL(/\/tickets\/[^/]+$/);
  await expect(page.getByText("Projektion · Geht nicht", { exact: true })).toBeVisible();
  const created = await db.ticket.findFirstOrThrow({
    where: { roomId: roomIds[32], title: "Synthetic desktop function fault" },
  });
  await page.goto(`/functions?buildingId=${buildingIds[0]}&functionId=${pictureId}`);
  await expect(page.getByRole("table")).toContainText("Synthetic desktop function fault");
  for (const id of [faultId, created.id]) {
    await transitionTicket({ name: "Synthetic browser technician" }, id, {
      status: "RESOLVED",
      resolution: "Synthetic repair",
    });
    await emitChange({ entityType: "ticket", id, op: "updated" });
  }
  await expect(page.getByRole("link", { name: "Hörsaal 33 · 33", exact: true })).toHaveCount(0);
  await page.goto(`/functions?functionId=not-installed`);
  await expect(page.getByText(t("de", "functions.list.empty"), { exact: true })).toBeVisible();
});
