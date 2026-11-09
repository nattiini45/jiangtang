import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { runPrefix } from "./run";

let event: { id: string; uid: string; title: string };

test.beforeAll(async () => {
  event = await db.event.create({
    data: {
      title: `${runPrefix()}Calendar publication`,
      startsAt: new Date("2040-03-25T09:00:00Z"),
      endsAt: new Date("2040-03-25T10:00:00Z"),
    },
  });
  await db.calendarOutbox.create({
    data: {
      eventUid: event.uid,
      op: "UPSERT",
      sequence: 0,
      payload: {},
      status: "PENDING",
    },
  });
});

test.afterAll(async () => {
  if (event) {
    await db.calendarOutbox.deleteMany({ where: { eventUid: event.uid } });
    await db.event.delete({ where: { id: event.id } });
  }
  await db.$disconnect();
});

for (const locale of ["de", "en"] as const) {
  for (const surface of ["desktop", "mobile"] as const) {
    test(`${surface} shows unconfigured publication clearly in ${locale}`, async ({
      page,
      baseURL,
    }, testInfo) => {
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "view", value: surface, url: baseURL! },
      ]);
      await page.setViewportSize(
        surface === "mobile" ? { width: 390, height: 844 } : { width: 1280, height: 960 },
      );
      await page.goto(`${surface === "mobile" ? "/m" : ""}/events/${event.id}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(event.title);
      const panel = page
        .locator("section")
        .filter({ hasText: locale === "de" ? "Kalender-Sync" : "Calendar sync" });
      await expect(panel).toContainText(locale === "de" ? "Nicht konfiguriert" : "Not configured");
      await expect(panel).not.toContainText(locale === "de" ? "Ausstehend" : "Pending");
      await expect(page.locator("body")).toHaveJSProperty(
        "scrollWidth",
        surface === "mobile" ? 390 : 1280,
      );
      await panel.scrollIntoViewIfNeeded();
      await panel.screenshot({
        path: testInfo.outputPath(`${surface}-${locale}-not-configured.png`),
      });
    });
  }
}
