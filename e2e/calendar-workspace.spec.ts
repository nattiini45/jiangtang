import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { runPrefix } from "./run";

const date = "2045-06-10";
const kinds = "events,service,tasks,projects,dates,faults";
let prefix: string;
const id = (name: string) => `${prefix}${name}`;

test.beforeAll(async () => {
  prefix = `${runPrefix()}workspace-calendar-`;
  await db.room.create({
    data: {
      id: id("room"),
      name: "Demo: Werkstatt mit Medien- und Veranstaltungstechnik",
      slug: id("room"),
      renewalFrom: new Date("2045-06-12T00:00Z"),
      renewalTo: new Date("2045-06-14T00:00Z"),
    },
  });
  await db.equipment.create({
    data: {
      id: id("device"),
      name: "Demo: Mobiles Übertragungssystem",
      category: "OTHER",
      roomId: id("room"),
    },
  });
  await db.event.create({
    data: {
      id: id("event"),
      title: "Demo: Technik für das Sommerfest",
      startsAt: new Date(`${date}T10:00Z`),
      endsAt: new Date(`${date}T12:00Z`),
      status: "CONFIRMED",
    },
  });
  for (const [kind, hour] of [
    ["SETUP", "08"],
    ["STANDBY", "09"],
    ["TEARDOWN", "13"],
  ] as const)
    await db.serviceWindow.create({
      data: {
        id: id(kind),
        eventId: id("event"),
        kind,
        startsAt: new Date(`${date}T${hour}:00Z`),
        endsAt: new Date(`${date}T${hour}:45Z`),
        roomId: id("room"),
      },
    });
  await db.eventRoomBooking.create({
    data: {
      eventId: id("event"),
      roomId: id("room"),
      startsAt: new Date(`${date}T10:00Z`),
      endsAt: new Date(`${date}T12:00Z`),
    },
  });
  await db.event.create({
    data: {
      id: id("preview-event"),
      title: "Demo: Bühnenprobe mit Ton und Bild",
      startsAt: new Date("2045-06-05T10:00Z"),
      endsAt: new Date("2045-06-05T12:00Z"),
      status: "CONFIRMED",
    },
  });
  for (const [kind, start, end] of [
    ["SETUP", "2045-06-05T08:00Z", "2045-06-05T09:00Z"],
    ["STANDBY", "2045-06-05T09:00Z", "2045-06-05T10:00Z"],
    ["TEARDOWN", "2045-06-06T12:00Z", "2045-06-06T14:00Z"],
  ] as const)
    await db.serviceWindow.create({
      data: {
        id: id(`preview-${kind}`),
        eventId: id("preview-event"),
        kind,
        startsAt: new Date(start),
        endsAt: new Date(end),
        roomId: id("room"),
      },
    });
  await db.project.create({
    data: {
      id: id("project"),
      name: "Demo: Sommerfest vorbereiten",
      slug: id("project"),
      startAt: new Date(`${date}T00:00Z`),
      dueAt: new Date("2045-06-11T00:00Z"),
    },
  });
  await db.event.create({
    data: {
      id: id("cancelled"),
      title: "Demo: Abgesagte Probe",
      startsAt: new Date("2045-06-20T10:00Z"),
      endsAt: new Date("2045-06-20T12:00Z"),
      status: "CANCELLED",
    },
  });
  await db.event.create({
    data: {
      id: id("several-days"),
      title: "Demo: Mehrtägiger Technikdienst",
      startsAt: new Date("2045-06-21T10:00Z"),
      endsAt: new Date("2045-06-23T12:00Z"),
      status: "CONFIRMED",
    },
  });
  for (let index = 0; index < 7; index++)
    await db.task.create({
      data: {
        id: id(`task${index}`),
        title: index === 0 ? "Demo: Funkstrecken prüfen" : `Demo: Technikcheck ${index}`,
        status: "TODO",
        dueAt: new Date(`${date}T00:00Z`),
      },
    });
  await db.inventoryItem.create({
    data: {
      id: id("stock"),
      name: "Demo: Ersatzverstärker",
      equipmentId: id("device"),
      warrantyExpiresAt: new Date("2045-06-16T00:00Z"),
    },
  });
  for (const scope of ["ROOM", "EQUIPMENT"] as const) {
    const fieldId = id(scope);
    await db.customField.create({
      data: {
        id: fieldId,
        key: `calendar_${scope.toLowerCase()}`,
        name: scope === "ROOM" ? "Sicherheitsbegehung" : "Firmware prüfen",
        type: "DATE",
        scope,
      },
    });
    if (scope === "ROOM")
      await db.room.update({
        where: { id: id("room") },
        data: { customValues: { [fieldId]: "2045-06-17" } },
      });
    else
      await db.equipment.update({
        where: { id: id("device") },
        data: { customValues: { [fieldId]: "2045-06-18" } },
      });
  }
  await db.ticket.create({
    data: {
      id: id("fault"),
      title: "Demo: Bild fällt aus",
      type: "INCIDENT",
      occurredAt: new Date("2045-06-19T10:00Z"),
      equipmentId: id("device"),
    },
  });
});

test.afterAll(async () => {
  const where = { id: { startsWith: prefix } };
  await db.eventRoomBooking.deleteMany({ where: { eventId: { startsWith: prefix } } });
  await db.serviceWindow.deleteMany({ where });
  await db.event.deleteMany({ where });
  await db.task.deleteMany({ where });
  await db.project.deleteMany({ where });
  await db.inventoryItem.deleteMany({ where });
  await db.ticket.deleteMany({ where });
  await db.customField.deleteMany({ where });
  await db.equipment.deleteMany({ where });
  await db.room.deleteMany({ where });
});

test("one calendar contains work, projects and events, and a full day opens from its count", async ({
  page,
}) => {
  await page.goto(`/calendar?view=month&date=${date}`);
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  const day = page.getByRole("region", { name: date, exact: true });
  await expect(day.locator('a[href^="/projects/"]')).toHaveCount(1);
  await expect(day.locator('a[href^="/tasks/"]')).toHaveCount(2);
  await day.getByRole("link", { name: "+9 weitere", exact: true }).click();
  await expect(page).toHaveURL(/view=day/);
  const band = page.locator("[data-whole-day-band]");
  await expect(band).toContainText("Demo: Funkstrecken prüfen");
  await expect(band).toContainText("Demo: Sommerfest vorbereiten");
  await expect(
    page
      .getByRole("link", { name: /Demo: Technik für das Sommerfest/ })
      .filter({ hasText: "Veranstaltungen" }),
  ).toBeVisible();
  await page.getByText("Anzeigen (6)", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Aufgaben", exact: true }).uncheck();
  await expect(band).not.toContainText("Demo: Funkstrecken prüfen");
  await page.getByRole("checkbox", { name: "Aufgaben", exact: true }).check();
  await expect(band).toContainText("Demo: Funkstrecken prüfen");
  await band.getByRole("link", { name: /Demo: Funkstrecken prüfen/ }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${id("task0")}`));
});

test("events are a plain list with named rooms and a calendar-day link", async ({ page }) => {
  await page.goto("/events");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Veranstaltungen");
  await expect(page.getByRole("navigation", { name: "Kalenderansichten" })).toHaveCount(0);
  const row = page
    .getByRole("link", { name: "Demo: Technik für das Sommerfest", exact: true })
    .locator("..")
    .locator("..");
  await expect(row).toContainText("Demo: Werkstatt");
  await row.getByRole("link", { name: "Tag im Kalender öffnen" }).click();
  await expect(page).toHaveURL(new RegExp(`/calendar\\?view=day&date=${date}`));
});

test("mobile agenda shows work and projects beside events and keeps choices", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/m/calendar?date=${date}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kalender");
  await expect(page.getByRole("link", { name: /Demo: Funkstrecken prüfen/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Demo: Sommerfest vorbereiten/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Veranstaltungen.*Demo: Technik/ })).toBeVisible();
  await page.getByText("Anzeigen (6)", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Aufgaben", exact: true }).uncheck();
  await expect(page.getByRole("link", { name: /Demo: Funkstrecken prüfen/ })).toHaveCount(0);
  await page.getByRole("link", { name: "Nächster Zeitraum" }).click();
  await expect(page).toHaveURL(/kinds=events%2Cservice%2Cprojects%2Cdates%2Cplans/);
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
});

test("multi-day entries use the band, faults are opt-in, and mobile cancellations are explicit", async ({
  page,
}) => {
  await page.goto("/calendar?view=day&date=2045-06-22");
  await expect(
    page
      .locator("[data-whole-day-band]")
      .getByRole("link", { name: /Demo: Mehrtägiger Technikdienst/ }),
  ).toBeVisible();
  await expect(page.locator('a[href*="several-days"]')).toHaveCount(1);
  await page.goto("/m/calendar?date=2045-06-20");
  const cancelled = page.getByRole("link", { name: /Demo: Abgesagte Probe/ });
  await expect(cancelled).toContainText("Abgesagt");
  await expect(cancelled.locator(".line-through")).toHaveText("Demo: Abgesagte Probe");
  await page.goto("/m/calendar?date=2045-06-19");
  await expect(page.getByRole("link", { name: /Demo: Bild fällt aus/ })).toHaveCount(0);
  await page.getByText("Anzeigen (6)", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Störungen", exact: true }).check();
  await expect(page.getByRole("link", { name: /Demo: Bild fällt aus/ })).toBeVisible();
});

for (const width of [1280, 1920])
  for (const locale of ["de", "en"])
    for (const theme of ["light", "dark"])
      for (const density of ["comfortable", "compact"]) {
        test(`@screens workspace month and events ${width} ${locale} ${theme} ${density}`, async ({
          page,
          baseURL,
        }) => {
          await page.setViewportSize({ width, height: 1000 });
          await page.context().addCookies(
            ["locale", "theme", "density"].map((name) => ({
              name,
              value: { locale, theme, density }[name]!,
              url: baseURL!,
            })),
          );
          await page.goto(`/calendar?view=month&date=${date}&kinds=${kinds}`);
          await expect(page.locator("html[data-hydrated]")).toBeAttached();
          await expect(page.getByRole("heading", { level: 1 })).toHaveText(
            locale === "de" ? "Kalender" : "Calendar",
          );
          await expect(page.getByRole("complementary")).toBeVisible();
          await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({
            path: `test-results/screens/workspace-month-${width}-${locale}-${theme}-${density}.png`,
            fullPage: true,
          });
          if (width === 1280 && locale === "de" && theme === "light" && density === "comfortable") {
            await page
              .getByRole("region", { name: date, exact: true })
              .screenshot({ path: "test-results/screens/workspace-overflow-de.png" });
            await page.getByText("Anzeigen (6)", { exact: true }).click();
            await page.screenshot({
              path: "test-results/screens/workspace-kinds-de.png",
              fullPage: true,
            });
            await page.goto(`/calendar?view=week&date=${date}&kinds=${kinds}`);
            await expect(page.locator("[data-whole-day-band]")).toHaveCount(7);
            await expect(page.locator("[data-whole-day-band] a").first()).toHaveCSS(
              "flex-shrink",
              "0",
            );
            await page.screenshot({
              path: "test-results/screens/workspace-week-de.png",
              fullPage: true,
            });
            await page.goto(`/calendar?view=day&date=${date}&kinds=${kinds}`);
            await expect(page.locator("[data-whole-day-band]")).toContainText(
              "Demo: Funkstrecken prüfen",
            );
            await page.screenshot({
              path: "test-results/screens/workspace-day-de.png",
              fullPage: true,
            });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.goto(`/m/calendar?date=${date}&kinds=${kinds}`);
            await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
            await page.screenshot({
              path: "test-results/screens/workspace-mobile-de.png",
              fullPage: true,
            });
            await page.setViewportSize({ width, height: 1000 });
          }
          for (const view of ["week", "day", "rooms"]) {
            await page.goto(`/calendar?view=${view}&date=${date}&kinds=${kinds}`);
            await expect(page.locator("html[data-hydrated]")).toBeAttached();
            await expect(page.getByRole("heading", { level: 1 })).toHaveText(
              locale === "de" ? "Kalender" : "Calendar",
            );
            await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
            await page.screenshot({
              path: `test-results/screens/workspace-${view}-${width}-${locale}-${theme}-${density}.png`,
              fullPage: true,
            });
          }
          await page.goto("/events");
          await expect(page.getByRole("heading", { level: 1 })).toHaveText(
            locale === "de" ? "Veranstaltungen" : "Events",
          );
          await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
          const grid = page.getByRole("main").locator(".overflow-auto").first();
          await expect(grid).toBeVisible();
          expect(await grid.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
            true,
          );
          await page.screenshot({
            path: `test-results/screens/workspace-events-${width}-${locale}-${theme}-${density}.png`,
            fullPage: true,
          });
        });
      }
