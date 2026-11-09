import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const ids: string[] = [];
const uids: string[] = [];

test.afterAll(async () => {
  await db.calendarOutbox.deleteMany({ where: { eventUid: { in: uids } } });
  await db.event.deleteMany({ where: { id: { in: ids } } });
  await db.$disconnect();
});

for (const locale of ["de", "en"] as const) {
  for (const surface of ["desktop", "mobile"] as const) {
    test(`${surface} deliberately reopens a cancelled event in ${locale}`, async ({
      page,
      baseURL,
    }, testInfo) => {
      const event = await db.event.create({
        data: {
          title: `${runPrefix()}Event reopening check`,
          status: "CANCELLED",
          startsAt: new Date("2041-09-01T10:00:00Z"),
          endsAt: new Date("2041-09-01T12:00:00Z"),
        },
      });
      ids.push(event.id);
      uids.push(event.uid);
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "view", value: surface, url: baseURL! },
      ]);
      const width = surface === "mobile" ? 390 : 1280;
      await page.setViewportSize({ width, height: surface === "mobile" ? 844 : 960 });
      const path = `${surface === "mobile" ? "/m" : ""}/events/${event.id}`;
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(event.title);
      const reopen = page.getByRole("button", {
        name: t(locale, "events.detail.reopen"),
        exact: true,
      });
      await expect(reopen).toBeVisible();
      await expect(reopen).toHaveAccessibleDescription(t(locale, "events.detail.reopenHint"));
      await expect(
        page.getByText(t(locale, "events.detail.reopenHint"), { exact: true }),
      ).toBeVisible();
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", width);
      if ((surface === "desktop" && locale === "en") || (surface === "mobile" && locale === "de")) {
        await page.screenshot({
          path: testInfo.outputPath(`${surface}-${locale}-reopen.png`),
          fullPage: true,
        });
      }
      let release!: () => void;
      let observed!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const submitted = new Promise<void>((resolve) => {
        observed = resolve;
      });
      await page.route(`**${path}.data*`, async (route) => {
        if (route.request().method() === "POST") {
          observed();
          await gate;
        }
        await route.continue();
      });
      const click = reopen.click();
      await submitted;
      try {
        await expect(reopen).toBeDisabled();
      } finally {
        release();
      }
      await click;
      await expect(reopen).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      expect((await db.event.findUniqueOrThrow({ where: { id: event.id } })).status).toBe(
        "PLANNED",
      );
      expect(
        await db.activityLog.count({ where: { entityId: event.id, action: "EventUpdated" } }),
      ).toBe(1);
      expect(await db.calendarOutbox.count({ where: { eventUid: event.uid } })).toBe(0);
      const saved = await db.event.findUniqueOrThrow({ where: { id: event.id } });
      const stale = await page.request.post(`${path}.data`, { form: { _action: "reopenEvent" } });
      expect(stale.ok()).toBe(true);
      expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toEqual(saved);
      expect(
        await db.activityLog.count({ where: { entityId: event.id, action: "EventUpdated" } }),
      ).toBe(1);
    });
  }
}
