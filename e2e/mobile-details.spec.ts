import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { insertOrConflict } from "~/lib/booking.server";
import { runPrefix } from "./run";

test.use({ viewport: { width: 390, height: 844 } });
let room: { id: string; slug: string; name: string };
let event: { id: string; title: string };
let note: { id: string; title: string };
let equipmentId: string;

test.beforeAll(async () => {
  const prefix = runPrefix();
  room = await db.room.create({
    data: {
      name: `${prefix}Medientechnik und Veranstaltungsraum mit langem Namen`,
      slug: `${prefix}room`,
      status: "TECH_DEFECT",
    },
  });
  event = await db.event.create({
    data: {
      title: `${prefix}Einweisung für die Medienausstattung und Veranstaltungstechnik`,
      startsAt: new Date("2026-10-25T09:00Z"),
      endsAt: new Date("2026-10-25T10:00Z"),
      contact: "contact@example.test",
      description: "Synthetischer Veranstaltungstext",
    },
  });
  await insertOrConflict(() =>
    db.eventRoomBooking.create({
      data: {
        roomId: room.id,
        eventId: event.id,
        startsAt: new Date("2026-10-25T08:00Z"),
        endsAt: new Date("2026-10-25T11:00Z"),
      },
    }),
  );
  const equipment = await db.equipment.create({
    data: { name: `${prefix}Projektor`, roomId: room.id, category: "OTHER", mobility: "FIXED" },
  });
  equipmentId = equipment.id;
  const author = await db.user.findUniqueOrThrow({ where: { email: process.env.ADMIN_EMAIL! } });
  note = await db.note.create({
    data: {
      authorId: author.id,
      title: `${prefix}Hinweise zur Veranstaltungstechnik und zur Raumnutzung`,
      tags: ["Veranstaltungstechnik", "Synthetische-Testnotiz"],
      body:
        "## Anleitung\n\nSicherer **Markdown-Text**.\n\n<script>window.mobileNoteXss=true</script>\n\n| Gerät | Hinweis |\n| --- | --- |\n| Projektor | Vor der Veranstaltung prüfen |\n\n```\n" +
        "long-code-".repeat(24) +
        "\n```",
    },
  });
});

test.afterAll(async () => {
  if (event) {
    await db.eventRoomBooking.deleteMany({ where: { eventId: event.id } });
    await db.event.delete({ where: { id: event.id } });
  }
  if (note) await db.note.deleteMany({ where: { id: note.id } });
  if (equipmentId) await db.equipment.deleteMany({ where: { id: equipmentId } });
  if (room) await db.room.deleteMany({ where: { id: room.id } });
  await db.$disconnect();
});

for (const theme of ["light", "dark"] as const) {
  test(`room schedule and read-only details stay on phone in ${theme} mode`, async ({
    page,
    baseURL,
  }) => {
    await page.context().addCookies([
      { name: "theme", value: theme, url: baseURL! },
      { name: "view", value: "mobile", url: baseURL! },
    ]);
    await page.goto(`/rooms/${room.slug}?date=2026-10-25`);
    await expect(page).toHaveURL(`/m/rooms/${room.slug}?date=2026-10-25`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(room.name);
    await expect(page.getByText("Technikdefekt", { exact: true })).toBeVisible();
    await expect(page.getByText(/nicht die tatsächliche Nutzung/)).toBeVisible();
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    for (const name of [
      "Vorheriger Zeitraum",
      "Nächster Zeitraum",
      "Heute",
      "Zurück zu den Räumen",
    ]) {
      expect(
        (await page.getByRole("link", { name, exact: true }).boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
    }
    await expect(
      page.getByRole("link", { name: `Eintrag zu ${runPrefix()}Projektor erfassen` }),
    ).toHaveAttribute("href", `/m/quick-entry?roomId=${room.id}&equipmentId=${equipmentId}`);
    const booking = page.getByRole("link").filter({ hasText: event.title });
    await expect(booking).toContainText("09:00");
    await expect(booking).toContainText("12:00");
    await booking.click();
    await expect(page).toHaveURL(`/m/events/${event.id}?date=2026-10-25`);
    await expect(page.getByRole("heading", { name: event.title, exact: true })).toBeVisible();
    await expect(
      page.getByText("25.10.2026, 10:00 – 25.10.2026, 11:00", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("contact@example.test", { exact: true })).toBeVisible();
    await expect(page.locator("input:not([type=hidden]), textarea, select")).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await page.getByRole("link", { name: "Kalender", exact: true }).click();
    await expect(page).toHaveURL("/m/calendar?date=2026-10-25");
    await page.getByRole("link").filter({ hasText: event.title }).click();
    await expect(page).toHaveURL(`/m/events/${event.id}?date=2026-10-25`);
    await page.goto(`/m/rooms/${room.slug}?date=2026-10-26`);
    await expect(page.getByText("Keine Buchungen an diesem Tag", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Neue Veranstaltung", exact: true }).click();
    await expect(page.locator('input[name="date"]')).toHaveValue("2026-10-26");
    await expect(page.locator('select[name="roomId"]')).toHaveValue(room.id);
    await page.goto("/m/notes");
    await page.getByRole("link").filter({ hasText: note.title }).click();
    await expect(page).toHaveURL(`/m/notes/${note.id}`);
    await expect(page.getByRole("heading", { name: note.title, exact: true })).toBeVisible();
    await expect(
      page.getByTestId("markdown-preview").getByRole("heading", { name: "Anleitung" }),
    ).toBeVisible();
    await expect(page.getByTestId("markdown-preview").locator("script")).toHaveCount(0);
    expect(await page.evaluate(() => "mobileNoteXss" in window)).toBe(false);
    await expect(page.locator("textarea, input[name='title']")).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 390);
    await page.getByRole("link", { name: "Zurück zu den Notizen", exact: true }).click();
    await expect(page).toHaveURL("/m/notes");
  });
}
