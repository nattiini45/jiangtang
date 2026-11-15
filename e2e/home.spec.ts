import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { db } from "~/lib/db.server";
import { Prisma } from "~/generated/prisma/client";
import { txWithAudit } from "~/lib/audit.server";
import { berlinDayIndex, berlinDayStartMs } from "~/lib/berlin-days";
import { defaultHomeLayout } from "~/domains/dashboard/home-layout";
import { t } from "~/i18n";
import { runPrefix } from "./run";

test.describe.configure({ mode: "serial" });
const evidence = "test-results/home";
const roomIds: string[] = [];
let userId: string;
let previousLayout: Prisma.JsonValue;
let roomId: string;
let eventId: string;
let roundId: string;
let taskId: string;
let prefix: string;

test.beforeAll(async () => {
  prefix = `${runPrefix()}home`;
  const user = await db.user.findUniqueOrThrow({ where: { email: process.env.ADMIN_EMAIL! } });
  userId = user.id;
  previousLayout = user.homeLayout;
  await db.user.update({ where: { id: userId }, data: { homeLayout: Prisma.DbNull } });
  const rooms = await db.room.createManyAndReturn({
    data: Array.from({ length: 70 }, (_, index) => ({
      name:
        index === 32 ? "Hörsaal 33" : `Synthetic room ${index + 1} with a long operational name`,
      roomNumber: `S.${index + 1}`,
      slug: `${prefix}-${index + 1}`,
    })),
  });
  roomIds.push(...rooms.map((room) => room.id));
  roomId = rooms.find((room) => room.roomNumber === "S.33")!.id;
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  await db.equipment.createMany({
    data: Array.from({ length: 213 }, (_, index) => ({
      roomId:
        index < 16 ? roomId : rooms.filter((room) => room.id !== roomId)[(index - 16) % 69].id,
      kindId: kind.id,
      category: "PROJECTOR" as const,
      name: `Synthetic projector ${index + 1}`,
      statusSince: new Date("2000-01-01T00:00:00Z"),
      createdAt: new Date("2000-01-01T00:00:00Z"),
      updatedAt: new Date("2000-01-01T00:00:00Z"),
    })),
  });
  const fn = await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } });
  await txWithAudit({ id: userId }, async (tx, audit) => {
    const ticket = await tx.ticket.create({
      data: {
        roomId,
        functionId: fn.id,
        impact: "DOWN",
        type: "INCIDENT",
        title: "Synthetic projection stays black",
        occurredAt: new Date("2001-01-01T00:00:00Z"),
        assignees: { connect: { id: userId } },
      },
    });
    await audit({ action: "TicketCreated", entityType: "ticket", entityId: ticket.id });
  });
  roundId = (
    await db.round.create({
      data: {
        name: "Synthetic pre-season round",
        startedAt: new Date("2001-01-01T00:00:00Z"),
        rooms: {
          create: rooms.map((room, index) => ({
            roomId: room.id,
            completedAt: index < 2 ? new Date("2026-01-01T00:00:00Z") : null,
          })),
        },
      },
    })
  ).id;
  const from = berlinDayStartMs(berlinDayIndex(new Date()));
  eventId = (
    await db.event.create({
      data: {
        title: "Synthetic room briefing",
        startsAt: new Date(from + 9 * 3_600_000),
        endsAt: new Date(from + 11 * 3_600_000),
        rooms: {
          create: {
            roomId,
            startsAt: new Date(from + 8 * 3_600_000),
            endsAt: new Date(from + 12 * 3_600_000),
          },
        },
      },
    })
  ).id;
  taskId = (
    await db.task.create({
      data: {
        title: "Synthetic projection check before the next booking",
        status: "TODO",
        dueAt: new Date("2000-01-01T00:00:00Z"),
        assignees: { create: { userId } },
      },
    })
  ).id;
  const linked = await db.ticket.create({
    data: {
      title: "Synthetic linked task ticket",
      type: "INCIDENT",
      roomId,
      taskId,
      assignees: { connect: { id: userId } },
    },
  });
  await db.task.update({ where: { id: taskId }, data: { ticketId: linked.id } });
  await db.ticket.create({
    data: {
      title: "Synthetic completed room work",
      type: "INCIDENT",
      status: "RESOLVED",
      roomId,
      assignees: { connect: { id: userId } },
    },
  });
  mkdirSync(evidence, { recursive: true });
});

test.afterAll(async () => {
  await db.user.update({
    where: { id: userId },
    data: {
      homeLayout:
        previousLayout === null ? Prisma.DbNull : (previousLayout as Prisma.InputJsonValue),
    },
  });
  await db.eventRoomBooking.deleteMany({ where: { eventId } });
  await db.event.delete({ where: { id: eventId } });
  await db.round.delete({ where: { id: roundId } });
  await db.task.delete({ where: { id: taskId } });
  await db.ticket.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.$disconnect();
});

const block = (page: Page, id: string) => page.locator(`[data-home-block="${id}"]`);
async function openHome(page: Page, url = "/") {
  await page.goto(url);
  await expect(
    page.getByRole("heading", { level: 1, name: "Übersicht", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
}

test("the default home finds the room fault, open round, today's booking and my work without arrangement", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "view", value: "desktop", url: baseURL! }]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openHome(page);
  await expect(page.locator("[data-home-block]")).toHaveCount(5);
  await expect(block(page, "faults")).toHaveAttribute("data-highlighted", "");
  await expect(
    block(page, "faults").getByRole("link", { name: "Hörsaal 33", exact: true }),
  ).toBeVisible();
  await expect(block(page, "faults")).toContainText("Synthetic projection stays black");
  await expect(block(page, "due")).toContainText("Synthetic pre-season round");
  await expect(block(page, "due")).toContainText("2 von 70 Räumen abgeschlossen");
  await expect(block(page, "today")).toContainText("Synthetic room briefing");
  await expect(block(page, "today")).toContainText("Ausfall im Raum: Projektion");
  await expect(block(page, "mine").getByRole("link").first()).toHaveText(
    "Synthetic projection check before the next booking",
  );
  await expect(block(page, "activity")).toContainText("Synthetic projection stays black");
  const result = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  await page.screenshot({
    path: `${evidence}/home-1280.png`,
    clip: { x: 0, y: 0, width: 1280, height: 760 },
  });
});

test("keyboard customising persists across a separate phone session and can be cancelled or reset there", async ({
  page,
  browser,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "view", value: "desktop", url: baseURL! }]);
  await openHome(page);
  const customise = page.getByRole("button", { name: "Anpassen", exact: true });
  await customise.focus();
  await page.keyboard.press("Space");
  await expect(customise).toHaveAttribute("aria-expanded", "true");
  for (const control of await page.getByRole("combobox").all()) {
    await control.focus();
    await page.keyboard.press("Space");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(control).toBeFocused();
  }
  const activity = page.getByRole("combobox", { name: "Was hat sich geändert", exact: true });
  await activity.focus();
  await page.keyboard.press("Space");
  await page.getByRole("option", { name: "Ausblenden", exact: true }).click();
  const mine = page.getByRole("combobox", { name: "Meine Aufgaben", exact: true });
  await mine.click();
  await page.getByRole("option", { name: "Hervorheben", exact: true }).click();
  for (let index = 0; index < 3; index++)
    await page.getByRole("button", { name: "Meine Aufgaben nach oben", exact: true }).click();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(customise).toHaveAttribute("aria-expanded", "false");
  await expect(customise).toBeFocused();
  await expect(
    page.getByRole("status").filter({ hasText: "Anordnung gespeichert." }),
  ).toBeVisible();
  await expect(page.locator("[data-home-block]").first()).toHaveAttribute(
    "data-home-block",
    "mine",
  );
  await expect(block(page, "activity")).toHaveCount(0);
  const context = await browser.newContext({
    baseURL,
    storageState: "e2e/.auth/admin.json",
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    await context.addCookies([{ name: "view", value: "mobile", url: baseURL! }]);
    const phone = await context.newPage();
    await openHome(phone, "/m");
    await expect(phone.locator("[data-home-block]").first()).toHaveAttribute(
      "data-home-block",
      "mine",
    );
    await expect(block(phone, "mine")).toHaveAttribute("data-highlighted", "");
    await expect(block(phone, "activity")).toHaveCount(0);
    await phone.reload();
    await expect(phone.locator("[data-home-block]").first()).toHaveAttribute(
      "data-home-block",
      "mine",
    );
    await phone.screenshot({ path: `${evidence}/phone-home.png` });
    await phone.getByRole("button", { name: "Anpassen", exact: true }).click();
    await phone.getByRole("button", { name: "Standard wiederherstellen", exact: true }).click();
    await phone.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await phone.reload();
    await expect(phone.locator("[data-home-block]").first()).toHaveAttribute(
      "data-home-block",
      "mine",
    );
    await phone.getByRole("button", { name: "Anpassen", exact: true }).click();
    await phone.screenshot({ path: `${evidence}/phone-customise.png` });
    await phone.getByRole("button", { name: "Standard wiederherstellen", exact: true }).click();
    await phone.getByRole("button", { name: "Speichern", exact: true }).click();
    await expect(phone.locator("[data-home-block]")).toHaveCount(5);
    await expect(phone.locator("[data-home-block]").first()).toHaveAttribute(
      "data-home-block",
      "faults",
    );
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await context.close();
  }
});

test("the SDK agent can discover and change home visibility controls", async ({
  page,
  baseURL,
}) => {
  await page.context().addCookies([{ name: "view", value: "desktop", url: baseURL! }]);
  await openHome(page);
  await page.getByRole("button", { name: "Anpassen", exact: true }).click();
  await page.evaluate(async (modulePath) => {
    const { uiAgent } = await import(modulePath);
    const result = await uiAgent.act({
      steps: [{ ref: "Was hat sich geändert", action: "setValue", args: ["hide"] }],
    });
    if (!result.ok) throw new Error(result.error?.message);
  }, "/app/lib/ui-agent.client.ts");
  await expect(
    page.getByRole("combobox", { name: "Was hat sich geändert", exact: true }),
  ).toHaveText("Ausblenden");
  await page.getByRole("button", { name: "Abbrechen", exact: true }).click();
  await expect(block(page, "activity")).toBeVisible();
});

test("the home keeps readable names and actions at both desktop widths, languages and densities", async ({
  page,
  baseURL,
}) => {
  for (const width of [1280, 1920])
    for (const locale of ["de", "en"] as const)
      for (const density of ["comfortable", "compact"]) {
        await page.context().addCookies([
          { name: "view", value: "desktop", url: baseURL! },
          { name: "locale", value: locale, url: baseURL! },
          { name: "density", value: density, url: baseURL! },
        ]);
        await page.setViewportSize({ width, height: 900 });
        for (const [route, title] of [
          ["/", "nav.overview"],
          ["/due", "dashboard.home.due.title"],
          ["/changes", "dashboard.home.activity.title"],
        ] as const) {
          await page.goto(route);
          await expect(
            page.getByRole("heading", { level: 1, name: t(locale, title), exact: true }),
          ).toBeVisible();
          if (route === "/") {
            await expect(
              page.getByRole("button", {
                name: t(locale, "dashboard.home.customise"),
                exact: true,
              }),
            ).toBeVisible();
          } else
            await expect(
              page
                .locator("main")
                .getByRole("link", { name: t(locale, "nav.overview"), exact: true }),
            ).toBeVisible();
          await expect(page.locator("aside")).toBeVisible();
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          for (const link of await page.locator("main a[title]").all())
            expect((await link.boundingBox())!.width).toBeGreaterThan(90);
          if (route === "/" && width === 1920 && locale === "de" && density === "comfortable")
            await page.screenshot({
              path: `${evidence}/home-1920.png`,
              clip: { x: 0, y: 0, width, height: 760 },
            });
          if (route !== "/" && width === 1280 && locale === "de" && density === "comfortable")
            await page.screenshot({
              path: `${evidence}/${route.slice(1)}-1280.png`,
              clip: { x: 0, y: 0, width, height: 760 },
            });
        }
      }
});

test("all hidden is recoverable, malformed preferences are rejected, and old queued capture posts still work", async ({
  page,
  baseURL,
}) => {
  const layout = defaultHomeLayout().map((entry) => ({ ...entry, mode: "hide" }));
  const saved = await page.request.post("/home-layout", {
    form: { layout: JSON.stringify(layout) },
  });
  expect(saved.ok()).toBe(true);
  const invalid = await page.request.post("/home-layout", {
    form: { layout: "[]", userId: "another-user" },
  });
  expect(invalid.status()).toBe(422);
  await page.context().addCookies([{ name: "view", value: "desktop", url: baseURL! }]);
  await openHome(page);
  await expect(page.locator("[data-home-block]")).toHaveCount(0);
  await page.getByRole("button", { name: "Anpassen", exact: true }).click();
  await page.getByRole("button", { name: "Standard wiederherstellen", exact: true }).click();
  await page.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.locator("[data-home-block]")).toHaveCount(5);
  const title = `${prefix}-legacy-capture`;
  const response = await page.request.post("/m?index", {
    form: { title, type: "INCIDENT", status: "OPEN", roomId },
    headers: { "x-jiangtang-capture-owner": userId },
  });
  expect(response.ok()).toBe(true);
  expect(await db.ticket.count({ where: { title } })).toBe(1);
});

test("every block opens its full operational view on desktop and phone", async ({
  page,
  baseURL,
}) => {
  for (const mobile of [false, true]) {
    await page
      .context()
      .addCookies([{ name: "view", value: mobile ? "mobile" : "desktop", url: baseURL! }]);
    const prefix = mobile ? "/m" : "";
    await openHome(page, prefix || "/");
    await block(page, "due").getByRole("link", { name: "Alles Fällige", exact: true }).click();
    await expect(page).toHaveURL(new URL(`${prefix}/due`, baseURL!).href);
    await expect(
      page.getByRole("heading", { level: 1, name: "Fällig", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Synthetic pre-season round", exact: true }),
    ).toBeVisible();
    await openHome(page, prefix || "/");
    await block(page, "activity")
      .getByRole("link", { name: "Alle wichtigen Änderungen", exact: true })
      .click();
    await expect(page).toHaveURL(new URL(`${prefix}/changes`, baseURL!).href);
    await expect(
      page.getByRole("heading", { level: 1, name: "Was hat sich geändert", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Synthetic projection stays black", exact: true }),
    ).toBeVisible();
    await openHome(page, prefix || "/");
    await block(page, "mine")
      .getByRole("link", { name: "Meine Tickets öffnen", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Meine Tickets", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Synthetic projection stays black", { exact: true })).toBeVisible();
    await expect(page.getByText("Beamer A.05 bleibt dunkel", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Synthetic linked task ticket", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Synthetic completed room work", { exact: true })).toHaveCount(0);
  }
});

test("a newly installed home can open capture offline without an earlier online visit to the form", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([{ name: "view", value: "mobile", url: baseURL! }]);
  await openHome(page, "/m");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const cachesForShell = (await caches.keys()).filter((name) =>
          name.startsWith("jiangtang-shell-"),
        );
        for (const name of cachesForShell) {
          const cache = await caches.open(name);
          if ((await cache.match("/m/quick-entry")) && (await cache.match("/m/quick-entry.data")))
            return true;
        }
        return false;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .some((entry) => entry.name.includes("m.quick-entry")),
      ),
    )
    .toBe(true);
  const title = `${prefix}-first-offline-capture`;
  await context.setOffline(true);
  try {
    await page.getByRole("link", { name: "Eintrag erfassen", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "Eintrag erfassen", exact: true }),
    ).toBeVisible();
    await page.locator('select[name="roomId"]').selectOption(roomId);
    await page.locator('input[name="title"]').fill(title);
    await page.getByRole("button", { name: "Eintrag erfassen", exact: true }).click();
    await expect(page.getByText(t("de", "mobile.capture.queued"), { exact: true })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => db.ticket.count({ where: { title } })).toBe(1);
});
