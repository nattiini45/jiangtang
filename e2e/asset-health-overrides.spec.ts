import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const eventIds: string[] = [];
const roomIds: string[] = [];
const equipmentIds: string[] = [];

test.afterAll(async () => {
  const events = await db.event.findMany({ where: { id: { in: eventIds } } });
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.equipmentAllocation.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.calendarOutbox.deleteMany({
    where: { eventUid: { in: events.map((event) => event.uid) } },
  });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
  await db.$disconnect();
});

for (const locale of ["en", "de"] as const) {
  for (const surface of ["desktop", "mobile"] as const) {
    test(`${surface} explicitly confirms an unhealthy booking in ${locale}`, async ({
      page,
      baseURL,
    }, testInfo) => {
      const room = await db.room.create({
        data: {
          name: "Synthetic out-of-service room",
          slug: `${runPrefix()}health-${surface}-${locale}`,
          status: "OUT_OF_SERVICE",
        },
      });
      roomIds.push(room.id);
      const title = `${runPrefix()}Asset health ${surface} ${locale}`;
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "view", value: surface, url: baseURL! },
      ]);
      await page.setViewportSize({
        width: surface === "desktop" ? 1280 : 390,
        height: surface === "desktop" ? 1000 : 844,
      });
      const params = new URLSearchParams({
        roomId: room.id,
        startsAt: "2045-05-02T10:00",
        endsAt: "2045-05-02T11:00",
      });
      await page.goto(`${surface === "mobile" ? "/m" : ""}/events/new?${params}`);
      const reason = page.getByRole("textbox", {
        name: t(locale, "events.health.reason"),
        exact: true,
      });
      const confirmation = page.getByRole("checkbox", {
        name: t(locale, "events.health.confirm"),
        exact: true,
      });
      await expect(
        page.getByText(t(locale, "events.health.roomWarning"), { exact: true }),
      ).toBeVisible();
      await expect(confirmation).not.toBeChecked();
      await page.locator('input[name="title"]').fill(title);
      const submit = page.getByRole("button", {
        name: t(locale, surface === "desktop" ? "events.new.submit" : "mobile.eventsNew.submit"),
        exact: true,
      });
      await reason.fill("Checked safe synthetic use");
      await submit.click();
      expect(
        await confirmation.evaluate((input: HTMLInputElement) => input.validity.valueMissing),
      ).toBe(true);
      expect(await db.event.count({ where: { title } })).toBe(0);
      await confirmation.check();
      await expect(page.locator("body")).toHaveJSProperty(
        "scrollWidth",
        surface === "desktop" ? 1280 : 390,
      );
      await page.screenshot({
        path: testInfo.outputPath(`${surface}-${locale}-initial-override.png`),
        fullPage: true,
      });
      await reason.fill("   ");
      await submit.click();
      await expect(reason).toHaveAttribute("aria-invalid", "true");
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: t(locale, "events.health.overrideRequired") })
          .first(),
      ).toBeVisible();
      expect(await db.event.count({ where: { title } })).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath(`${surface}-${locale}-override-rejected.png`),
        fullPage: true,
      });
      await reason.fill("Checked safe synthetic use");
      await submit.click();
      await expect(page).not.toHaveURL(/\/events\/new/);
      const event = await db.event.findFirstOrThrow({ where: { title } });
      eventIds.push(event.id);
      const booking = await db.eventRoomBooking.findFirstOrThrow({ where: { eventId: event.id } });
      const admin = await db.user.findUniqueOrThrow({ where: { email: process.env.ADMIN_EMAIL } });
      const audit = await db.activityLog.findFirstOrThrow({
        where: { entityId: booking.id, action: "RoomBooked" },
      });
      expect(audit.actorId).toBe(admin.id);
      expect(audit.data).toMatchObject({
        healthOverride: { status: "OUT_OF_SERVICE", reason: "Checked safe synthetic use" },
      });

      if (surface === "mobile") {
        await page.goto(`/m/events/${event.id}`);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
        await expect(page.locator('[name="healthOverrideReason"]')).toHaveCount(0);
        return;
      }

      const addRoom = page.locator("#add-room-form");
      await addRoom.locator('select[name="roomId"]').selectOption(room.id);
      await addRoom.locator('input[name="startsAt"]').fill("2045-05-02T11:00");
      await addRoom.locator('input[name="endsAt"]').fill("2045-05-02T12:00");
      await addRoom
        .getByRole("textbox", { name: t(locale, "events.health.reason") })
        .fill("Checked a later synthetic booking");
      await addRoom.getByRole("checkbox", { name: t(locale, "events.health.confirm") }).check();
      await addRoom
        .getByRole("button", { name: t(locale, "events.detail.bookRoom"), exact: true })
        .click();
      await expect.poll(() => db.eventRoomBooking.count({ where: { eventId: event.id } })).toBe(2);

      const equipment = await db.equipment.create({
        data: {
          name: "Synthetic faulty pooled unit",
          category: "OTHER",
          status: "FAULTY",
          mobility: "POOLED",
        },
      });
      equipmentIds.push(equipment.id);
      await page.reload();
      const allocation = page.locator("#add-allocation-form");
      await allocation.locator('select[name="equipmentId"]').selectOption(equipment.id);
      await expect(
        allocation.getByText(t(locale, "events.health.equipmentWarning"), { exact: true }),
      ).toBeVisible();
      await allocation
        .getByRole("textbox", { name: t(locale, "events.health.reason") })
        .fill("Checked safe synthetic equipment use");
      await allocation.getByRole("checkbox", { name: t(locale, "events.health.confirm") }).check();
      await allocation.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`desktop-${locale}-allocation-override.png`),
        fullPage: true,
      });
      await allocation
        .getByRole("button", { name: t(locale, "events.detail.allocateEquipment"), exact: true })
        .click();
      await expect
        .poll(() => db.equipmentAllocation.count({ where: { eventId: event.id } }))
        .toBe(1);
      const saved = await db.equipmentAllocation.findFirstOrThrow({ where: { eventId: event.id } });
      expect(
        (
          await db.activityLog.findFirstOrThrow({
            where: { entityId: saved.id, action: "EquipmentAllocated" },
          })
        ).data,
      ).toMatchObject({
        healthOverride: { status: "FAULTY", reason: "Checked safe synthetic equipment use" },
      });
    });
  }
}
