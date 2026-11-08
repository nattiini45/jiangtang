import { expect, test, type Page } from "@playwright/test";
import { runPrefix } from "./run";
import { db } from "~/lib/db.server";

async function openCalendar(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
}

test("calendar views persist their date and filters in the URL", async ({ page }) => {
  await openCalendar(page, "/events?date=2026-11-08");
  await expect(page.getByRole("link", { name: "Woche", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "Monat", exact: true }).click();
  await expect(page).toHaveURL(/view=month/);
  await expect(page).toHaveURL(/date=2026-11-08/);
  await page.getByLabel("Aufgabenfälligkeiten anzeigen").check();
  await expect(page).toHaveURL(/tasks=1/);
  await page.getByRole("link", { name: "Nächster Zeitraum" }).click();
  await expect(page).toHaveURL(/date=2026-12-01/);
  await expect(page).toHaveURL(/tasks=1/);
  await page.getByRole("link", { name: "Liste", exact: true }).click();
  await expect(page.getByRole("button", { name: "Titel", exact: true })).toBeVisible();
});

test("a room slot opens a prefilled conflict-checked booking", async ({ page }) => {
  await openCalendar(page, "/events?view=rooms");
  const freeSlot = page.getByRole("link", { name: /Demo-Raum A.01.*09:00/ });
  const url = new URL((await freeSlot.getAttribute("href")) ?? "", "http://localhost");
  await freeSlot.click();
  await expect(page).toHaveURL(/events\/new/);
  await expect(page.locator('select[name="roomId"]')).toHaveValue(url.searchParams.get("roomId")!);
  await expect(page.locator('input[name="startsAt"]')).not.toHaveValue("");
  const response = page.waitForResponse(
    (res) => res.url().includes("/api/events/check-conflict") && res.status() === 200,
  );
  await page.locator('input[name="endsAt"]').fill("2030-01-01T12:00");
  await response;
});

test("calendar slots support keyboard navigation and exact Berlin transition days", async ({
  page,
}) => {
  for (const [date, hours] of [
    ["2026-03-29", 23],
    ["2026-10-25", 25],
  ] as const) {
    await openCalendar(page, `/events?view=day&date=${date}`);
    const slots = page.locator("a[data-slot-row]");
    await expect(slots).toHaveCount(hours);
    await slots.nth(9).focus();
    await page.keyboard.press("ArrowDown");
    await expect(slots.nth(10)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(slots.first()).toBeFocused();
  }
});

test("mobile agenda stays within 390px and creates on the selected day", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCalendar(page, "/m/events?date=2026-10-25");
  await expect(page.locator('input[name="date"]')).toHaveValue("2026-10-25");
  await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
  await page.getByRole("link", { name: "Neue Veranstaltung", exact: true }).click();
  await expect(page.locator('input[name="date"]')).toHaveValue("2026-10-25");
  await expect(page.locator('input[name="startTime"]')).toHaveValue("09:00");
});

test("the shared week gutter aligns transition hours without phantom slots", async ({ page }) => {
  for (const [date, rows, hours, threeRow] of [
    ["2026-03-29", 24, 23, "3"],
    ["2026-10-25", 25, 25, "4"],
  ] as const) {
    await openCalendar(page, `/events?view=week&date=${date}`);
    const gutter = page.locator("[data-time-gutter]");
    await expect(gutter).toHaveCount(1);
    await expect(gutter.locator(":scope > div")).toHaveCount(rows);
    const sunday = page.getByRole("region", { name: date, exact: true });
    await expect(sunday.locator("a[data-slot-row]")).toHaveCount(hours);
    await expect(sunday.locator('a[data-slot-time="180"]')).toHaveAttribute(
      "data-slot-row",
      threeRow,
    );
    await expect(page.locator('a[data-slot-column="0"][data-slot-time="180"]')).toHaveAttribute(
      "data-slot-row",
      threeRow,
    );
    if (hours === 23) {
      await expect(sunday.locator('a[data-slot-time="120"]')).toHaveCount(0);
    } else {
      await expect(sunday.locator('a[data-slot-time="120"]')).toHaveCount(2);
      await expect(gutter).toContainText("02:00 MESZ");
      await expect(gutter).toContainText("02:00 MEZ");
      await expect(page.locator('a[data-slot-column="0"][data-slot-row="3"]')).toHaveCount(0);
    }
    const three = sunday.locator('a[data-slot-time="180"]');
    await three.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator('a[data-slot-column="5"][data-slot-time="180"]')).toBeFocused();
  }
});

test("day drilling preserves tasks and resource filters", async ({ page }) => {
  await openCalendar(page, "/events?view=month&date=2026-11-08&tasks=1&room=seed_room_a01");
  await page
    .getByRole("region", { name: "2026-11-08", exact: true })
    .getByRole("link", { name: "8", exact: true })
    .click();
  await expect(page).toHaveURL(/view=day/);
  await expect(page).toHaveURL(/tasks=1/);
  await expect(page).toHaveURL(/room=seed_room_a01/);
});

test("room keyboard navigation skips occupied hours without changing rooms", async ({ page }) => {
  await openCalendar(page, "/events?view=rooms&status=CONFIRMED&equipment=missing");
  await expect(page.getByRole("link", { name: /Demo-Hybridveranstaltung/ })).toBeVisible();
  const before = page.getByRole("link", { name: /Demo-Raum A.01.*09:00/ });
  await before.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("link", { name: /Demo-Raum A.01.*12:00/ })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(before).toBeFocused();
});

test("day headers stay visible while scrolling the time grid", async ({ page }) => {
  await openCalendar(page, "/events?view=week");
  const scroller = page.locator('[data-slot-orientation="vertical"]');
  const heading = scroller.getByRole("heading", { level: 2 }).first();
  await expect(heading).toBeVisible();
  await scroller.evaluate((element) => {
    element.scrollTop = 100;
  });
  const before = await heading.boundingBox();
  await scroller.evaluate((element) => {
    element.scrollTop = 500;
  });
  await expect.poll(async () => (await heading.boundingBox())!.y).toBeCloseTo(before!.y, 0);
});

test("an empty calendar slot creates a booked event and releases it on cancellation", async ({
  page,
}) => {
  const title = `${runPrefix()}calendar booking`;
  await openCalendar(page, "/events?view=rooms&date=2042-06-02");
  await expect(page.locator('[data-slot-orientation="horizontal"]')).toHaveJSProperty(
    "scrollLeft",
    6 * 88,
  );
  await page.getByRole("link", { name: /Demo-Raum A.01.*09:00/ }).click();
  await page.locator('input[name="title"]').fill(title);
  await page.getByRole("button", { name: "Veranstaltung anlegen", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const createdUrl = page.url();
  let released = false;
  try {
    await expect(page.getByText("Demo-Raum A.01", { exact: true }).first()).toBeVisible();
    await page.getByText("Veranstaltung bearbeiten", { exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Veranstaltung absagen", exact: true }).click();
    await expect(
      page.getByText("Abgesagt — Räume und Geräte sind freigegeben.", { exact: true }),
    ).toBeVisible();
    released = true;
    await openCalendar(page, "/events?view=rooms&date=2042-06-02");
    await expect(page.getByRole("link", { name: /Demo-Raum A.01.*09:00/ })).toBeVisible();
  } finally {
    if (!released) await page.request.post(createdUrl, { form: { _action: "cancelEvent" } });
    const event = await db.event.findUniqueOrThrow({
      where: { id: new URL(createdUrl).pathname.split("/").at(-1) },
    });
    await db.eventRoomBooking.deleteMany({ where: { eventId: event.id } });
    await db.calendarOutbox.deleteMany({ where: { eventUid: event.uid } });
    await db.event.delete({ where: { id: event.id } });
  }
});
