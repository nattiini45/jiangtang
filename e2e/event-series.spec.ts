import { expect, test, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";
import { berlinDayIndex, dayIndexToDateKey, isoWeekday } from "~/lib/berlin-days";
import { berlinLocalToUtc } from "~/lib/time.server";
import { formatDate } from "~/i18n/format";
import { eventStatusLabel } from "~/components/events/labels";
import { t } from "~/i18n";
import { runPrefix } from "./run";

async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("exposes the recurrence controls to the UI agent at both desktop densities", async ({
  page,
  baseURL,
}, testInfo) => {
  for (const locale of ["en", "de"] as const) {
    for (const density of ["comfortable", "compact"] as const) {
      await page.context().addCookies([
        { name: "locale", value: locale, url: baseURL! },
        { name: "view", value: "desktop", url: baseURL! },
        { name: "density", value: density, url: baseURL! },
      ]);
      await page.setViewportSize({ width: 1280, height: 960 });
      await page.goto("/events/new");
      await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
      const label = t(locale, "events.series.frequency");
      await page.evaluate(
        async ({ modulePath, label }) => {
          const { uiAgent } = await import(modulePath);
          const result = await uiAgent.act({
            steps: [{ ref: label, action: "setValue", args: ["monthly"] }],
          });
          if (!result.ok) throw new Error(result.error?.message);
        },
        { modulePath: "/app/lib/ui-agent.client.ts", label },
      );
      await expect(page.getByRole("combobox", { name: label, exact: true })).toHaveText(
        t(locale, "events.series.monthly"),
      );
      await choose(page, t(locale, "events.series.end"), t(locale, "events.series.byCount"));
      await expect(
        page.getByRole("spinbutton", { name: t(locale, "events.series.count") }),
      ).toBeVisible();
      await expect(page.locator("aside nav")).toBeVisible();
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1280);
      if (locale === "de" && density === "compact") {
        await page.setViewportSize({ width: 1920, height: 960 });
        await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1920);
        await page.screenshot({
          path: testInfo.outputPath("series-monthly-de-compact.png"),
          fullPage: true,
        });
      }
    }
  }
});

test("creates a recurring room booking, detaches one date and edits or cancels following dates", async ({
  page,
  baseURL,
}, testInfo) => {
  const locale = "en";
  const title = "Weekly production check";
  const room = await db.room.create({
    data: { name: "Studio East", slug: `${runPrefix()}series-room` },
  });
  const nextWeek = berlinDayIndex(new Date()) + 7;
  const firstDay = nextWeek + ((3 - isoWeekday(nextWeek) + 7) % 7);
  const dates = Array.from({ length: 6 }, (_, i) => dayIndexToDateKey(firstDay + 7 * i));
  const at = (date: string, time: string) => berlinLocalToUtc(`${date}T${time}`);
  const occupied = await db.event.create({
    data: {
      title: "Room maintenance",
      startsAt: at(dates[1], "10:00"),
      endsAt: at(dates[1], "11:00"),
      rooms: {
        create: { roomId: room.id, startsAt: at(dates[1], "10:00"), endsAt: at(dates[1], "11:00") },
      },
    },
  });
  const series = () =>
    db.event.findMany({
      where: { title, rooms: { some: { roomId: room.id } } },
      orderBy: { occurrenceKey: "asc" },
    });
  const edit = async (id: string, date: string, time: string, end: string, following = false) => {
    await page.goto(`/events/${id}`);
    await page.getByText(t(locale, "events.detail.edit"), { exact: true }).click();
    const form = page.locator('form:has(input[name="_action"][value="updateEvent"])');
    await form.locator('input[name="startsAt"]').fill(`${date}T${time}`);
    await form.locator('input[name="endsAt"]').fill(`${date}T${end}`);
    if (following) {
      await choose(
        page,
        t(locale, "events.series.editScope"),
        t(locale, "events.series.following"),
      );
      await expect(
        form.getByText(t(locale, "events.series.bookedRooms", { rooms: room.name })),
      ).toBeVisible();
      await expect(
        form.getByRole("link", { name: t(locale, "events.series.manageRooms") }),
      ).toHaveAttribute("href", "#event-rooms");
      await page
        .getByRole("combobox", { name: t(locale, "events.series.editScope"), exact: true })
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.screenshot({ path: testInfo.outputPath("series-edit-scope.png") });
    }
    await page.getByRole("button", { name: t(locale, "events.detail.saveChanges") }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect
      .poll(async () => (await db.event.findUniqueOrThrow({ where: { id } })).startsAt)
      .toEqual(at(date, time));
  };
  await page.context().addCookies([
    { name: "locale", value: locale, url: baseURL! },
    { name: "view", value: "desktop", url: baseURL! },
    { name: "density", value: "comfortable", url: baseURL! },
  ]);
  await page.setViewportSize({ width: 1280, height: 960 });
  try {
    await page.goto(
      `/events/new?roomId=${room.id}&startsAt=${dates[0]}T10:00&endsAt=${dates[0]}T11:00`,
    );
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
    await page.locator('input[name="title"]').fill(title);
    const repeat = page.getByRole("combobox", {
      name: t(locale, "events.series.frequency"),
      exact: true,
    });
    await repeat.focus();
    await repeat.press("Enter");
    await expect(
      page.getByRole("option", { name: t(locale, "events.series.weekly"), exact: true }),
    ).toBeVisible();
    await page
      .getByRole("option", { name: t(locale, "events.series.weekly"), exact: true })
      .click();
    const weekday = page
      .getByRole("group", { name: t(locale, "events.series.weekdays") })
      .getByRole("checkbox", { checked: true });
    await expect(weekday).toHaveCount(1);
    await weekday.press("Space");
    await expect(weekday).toHaveCount(0);
    await page.getByLabel(t(locale, "events.series.lastDate")).fill(dates[5]);
    await page.getByRole("button", { name: t(locale, "events.series.submit") }).click();
    await expect(page.getByText(t(locale, "events.series.chooseWeekday"))).toBeVisible();
    await expect(
      page.getByRole("spinbutton", { name: t(locale, "events.series.interval") }),
    ).not.toHaveAttribute("aria-invalid", "true");
    const wednesday = page.getByRole("checkbox", { name: "Wednesday", exact: true });
    await wednesday.press("Space");
    await expect(wednesday).toBeChecked();
    await expect(weekday).toHaveCount(1);
    await expect(page.getByText(t(locale, "events.series.chooseWeekday"))).toHaveCount(0);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 1280);
    const submit = page.getByRole("button", { name: t(locale, "events.series.submit") });
    await submit.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const header = document.querySelector("header")!;
          const rect = header.getBoundingClientRect();
          return (
            scrollY > 0 &&
            rect.top === 0 &&
            document
              .elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
              ?.closest("header") === header
          );
        }),
      )
      .toBe(true);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.querySelector("h1")!.getBoundingClientRect().top >
            document.querySelector("header")!.getBoundingClientRect().bottom,
        ),
      )
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath("series-create.png"), fullPage: true });
    await submit.click();
    await expect(
      page.getByRole("heading", { name: t(locale, "events.series.result") }),
    ).toBeVisible();
    await expect(page.getByText(t(locale, "events.series.saved", { count: 5 }))).toBeVisible();
    await expect(
      page.getByText(formatDate(locale, `${dates[1]}T12:00:00Z`), { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(t(locale, "work.err.event.roomAlreadyBooked"), { exact: false }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("series-conflict.png") });
    const events = await series();
    expect(events.map(({ occurrenceKey }) => occurrenceKey)).toEqual(
      dates.filter((_, i) => i !== 1),
    );
    const [first, second, third, fourth, fifth] = events;
    await page.goto(`/calendar?view=week&date=${dates[2]}&roomId=${room.id}`);
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await page.goto(`/calendar?view=rooms&date=${dates[2]}&roomId=${room.id}`);
    await expect(page.getByRole("link", { name: new RegExp(`^${title} Planned`) })).toBeVisible();
    await edit(third.id, dates[3], "11:00", "12:00");
    await edit(second.id, dates[2], "12:00", "13:00", true);
    expect((await series()).map(({ startsAt }) => startsAt)).toEqual([
      at(dates[0], "10:00"),
      at(dates[2], "12:00"),
      at(dates[3], "11:00"),
      at(dates[4], "12:00"),
      at(dates[5], "12:00"),
    ]);
    const active = await db.eventRoomBooking.findMany({
      where: { roomId: room.id, cancelled: false, eventId: { in: events.map(({ id }) => id) } },
      orderBy: { startsAt: "asc" },
    });
    expect(active.map(({ startsAt }) => startsAt)).toEqual(
      (await series()).map(({ startsAt }) => startsAt),
    );
    await page.goto(`/events/${fourth.id}`);
    await page.getByText(t(locale, "events.detail.edit"), { exact: true }).click();
    await choose(
      page,
      t(locale, "events.series.cancelScope"),
      t(locale, "events.series.following"),
    );
    await page
      .getByRole("combobox", { name: t(locale, "events.series.cancelScope"), exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("series-scope.png") });
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: t(locale, "events.detail.cancelEvent"), exact: true })
      .click();
    await expect(
      page.getByText(
        t(locale, "events.detail.cancelledNote", { status: eventStatusLabel(locale, "CANCELLED") }),
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      (await series()).filter(({ status }) => status === "CANCELLED").map(({ id }) => id),
    ).toEqual([fourth.id, fifth.id]);
    expect((await db.event.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("PLANNED");
  } finally {
    const ids = [occupied.id, ...(await series()).map(({ id }) => id)];
    await db.eventRoomBooking.deleteMany({ where: { eventId: { in: ids } } });
    await db.event.deleteMany({ where: { id: { in: ids } } });
    await db.eventSeries.deleteMany({
      where: { definition: { path: ["rooms", "0", "roomId"], equals: room.id } },
    });
    await db.room.delete({ where: { id: room.id } });
  }
});
