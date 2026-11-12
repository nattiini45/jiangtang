import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { createEventWithBooking } from "~/domains/events/events.mutations.server";
import { eventCreateSchema, roomBookingCreateSchema } from "~/domains/events/events.schema";
import type { AuditActor } from "~/lib/audit.server";
import { runPrefix } from "./run";

const eventIds: string[] = [];
const eventUids: string[] = [];
const roomIds: string[] = [];
const taskIds: string[] = [];
const equipmentIds: string[] = [];

test.beforeAll(async () => {
  const admin = await db.user.findFirstOrThrow({ where: { email: process.env.ADMIN_EMAIL } });
  const actor: AuditActor = { id: admin.id, name: admin.name, initials: admin.initials };
  const prefix = runPrefix();
  for (const [index, name] of ["Demo-Hörsaal B.02", "Demo-Seminarraum C.14"].entries()) {
    const room = await db.room.create({ data: { name, slug: `${prefix}calendar-room-${index}` } });
    roomIds.push(room.id);
  }
  const create = async (
    title: string,
    roomId: string,
    startsAt: string,
    endsAt: string,
    instants?: { startsAtInstant: string; endsAtInstant: string },
  ) => {
    const event = await createEventWithBooking(
      actor,
      eventCreateSchema.parse({ title, startsAt, endsAt, status: "CONFIRMED", ...instants }),
      roomBookingCreateSchema.parse({ roomId, startsAt, endsAt, ...instants }),
    );
    eventIds.push(event.id);
    eventUids.push(event.uid);
    return event;
  };
  const lecture = await create(
    "Demo: Ringvorlesung – hybride Übertragung",
    "seed_room_a01",
    "2026-11-09T09:00",
    "2026-11-09T11:00",
  );
  await create(
    "Demo: Seminar zu Hörtechnik und Mikrofonie",
    roomIds[0],
    "2026-11-09T10:00",
    "2026-11-09T12:00",
  );
  await create("Demo: Prüfungsvorbereitung AV", roomIds[1], "2026-11-09T13:00", "2026-11-09T14:30");
  await create(
    "Demo: Aufbau und Soundcheck für den Hochschulabend",
    "seed_room_a01",
    "2026-11-09T14:00",
    "2026-11-09T16:00",
  );
  await create(
    "Demo: Bereitschaft vor der Zeitumstellung",
    "seed_room_a01",
    "2026-10-25T02:00",
    "2026-10-25T02:45",
    { startsAtInstant: "2026-10-25T00:00:00.000Z", endsAtInstant: "2026-10-25T00:45:00.000Z" },
  );
  await create(
    "Demo: Übergabe nach der Zeitumstellung",
    "seed_room_a01",
    "2026-10-25T02:00",
    "2026-10-25T02:45",
    { startsAtInstant: "2026-10-25T01:00:00.000Z", endsAtInstant: "2026-10-25T01:45:00.000Z" },
  );
  const equipment = await db.equipment.create({
    data: { name: "Demo-Funkmikrofon-Set", category: "AUDIO", mobility: "POOLED" },
  });
  equipmentIds.push(equipment.id);
  await db.equipmentAllocation.create({
    data: {
      eventId: lecture.id,
      equipmentId: equipment.id,
      startsAt: lecture.startsAt,
      endsAt: lecture.endsAt,
    },
  });
  for (const title of [
    "Demo: Technikcheck für die Ringvorlesung",
    "Demo: Mikrofone laden und Reserve bereitstellen",
  ]) {
    const task = await db.task.create({
      data: { title, dueAt: new Date("2026-11-09T11:00:00Z"), status: "TODO" },
    });
    taskIds.push(task.id);
  }
});

test.afterAll(async () => {
  await db.equipmentAllocation.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.calendarOutbox.deleteMany({ where: { eventUid: { in: eventUids } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.equipment.deleteMany({ where: { id: { in: equipmentIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.task.deleteMany({ where: { id: { in: taskIds } } });
});

const CASES = [
  ["calendar-populated-month", "/calendar?view=month&date=2026-11-09&tasks=1"],
  ["calendar-populated-week", "/calendar?view=week&date=2026-11-09&tasks=1"],
  ["calendar-populated-rooms", "/calendar?view=rooms&date=2026-11-09"],
  ["calendar-focused-slot", "/calendar?view=rooms&date=2026-11-09"],
  ["calendar-dst-day", "/calendar?view=day&date=2026-10-25"],
  ["calendar-tasks-day", "/calendar?view=day&date=2026-11-09&tasks=1"],
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const [name, path] of CASES) {
    test(`@screens ${name} [${theme}]`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.context().addCookies([
        { name: "theme", value: theme, url: new URL(baseURL!).origin },
        { name: "locale", value: "de", url: new URL(baseURL!).origin },
      ]);
      await page.goto(path);
      await expect(page.locator("html[data-hydrated]")).toBeAttached();
      await expect(
        page.getByRole("heading", { level: 1, name: "Kalender", exact: true }),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      if (name === "calendar-populated-month")
        await expect(page.getByRole("link", { name: /\+\d+ weitere/ }).first()).toBeVisible();
      if (name === "calendar-populated-week") {
        await expect(page.locator("[data-time-gutter]")).toHaveCount(1);
        await expect(page.locator("a[data-slot-row]").first()).toHaveText("");
        const title = page.getByText("Demo: Prüfungsvorbereitung AV", { exact: true });
        const card = title.locator("xpath=ancestor::a");
        await expect(card).toContainText("13:00");
        await expect(card).toHaveAttribute("title", /Demo: Prüfungsvorbereitung AV/);
        await expect(title).toHaveAttribute("lang", "de");
        await expect(title).toHaveCSS("hyphens", "auto");
        await expect(title).toHaveCSS("-webkit-line-clamp", "2");
        const label = title.locator("..");
        await expect(label.locator("span").first()).toHaveText("Veranstaltungen · 13:00");
        expect(
          await title.evaluate((element) => element.getBoundingClientRect().height),
        ).toBeLessThanOrEqual(32);
      }
      if (name === "calendar-dst-day") {
        await expect(page.locator("a[data-slot-row]")).toHaveCount(25);
        await expect(
          page
            .locator('a[href^="/events/"]')
            .filter({ hasText: "Demo: Bereitschaft vor der Zeitumstellung" }),
        ).toContainText("02:00 MESZ");
        await expect(
          page
            .locator('a[href^="/events/"]')
            .filter({ hasText: "Demo: Übergabe nach der Zeitumstellung" }),
        ).toContainText("02:00 MEZ");
        await page.locator('[data-slot-orientation="vertical"]').evaluate((element) => {
          element.scrollTop = 0;
        });
      }
      if (name === "calendar-focused-slot")
        await page.getByRole("link", { name: /Demo-Raum A.01.*12:00/ }).focus();
      await page.screenshot({ path: `test-results/screens/${name}-${theme}.png`, fullPage: true });
    });
  }
}
