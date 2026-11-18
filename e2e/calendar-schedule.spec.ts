import { expect, test, type Locator, type Page } from "@playwright/test";
import { createEventSeries } from "~/domains/events/event-series.mutations.server";
import { eventSeriesSchema } from "~/domains/events/event-series.schema";
import { db } from "~/lib/db.server";
import { runPrefix } from "./run";

async function drag(page: Page, source: Locator, dy: number) {
  await source.scrollIntoViewIfNeeded();
  const box = (await source.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("calendar drag saves an occurrence, refetches another session and reports a private conflict", async ({
  page,
  context,
  browser,
  baseURL,
}, testInfo) => {
  const title = "Demo: Sound check";
  const day = "2045-06-07";
  const at = (time: string) => new Date(`${day}T${time}:00+02:00`);
  const slug = `${runPrefix()}reschedule`;
  const room = await db.room.create({ data: { name: "Demo: Stage room", slug } });
  const equipment = await db.equipment.create({
    data: { name: "Demo: Wireless set", category: "AUDIO", mobility: "POOLED" },
  });
  const series = await createEventSeries(
    { name: "Demo Scheduler" },
    eventSeriesSchema.parse({
      event: { title, startsAt: `${day}T09:00`, endsAt: `${day}T10:00` },
      rule: { frequency: "daily" },
      end: { kind: "count", count: 2 },
      rooms: [{ roomId: room.id }],
      equipment: [{ equipmentId: equipment.id }],
    }),
    at("08:00"),
  );
  const [eventId, followingId] = series.eventIds;
  await db.serviceWindow.create({
    data: { eventId, kind: "SETUP", startsAt: at("08:30"), endsAt: at("09:00") },
  });
  await db.event.create({
    data: {
      title: "Synthetic private booking",
      startsAt: at("13:00"),
      endsAt: at("14:00"),
      rooms: { create: { roomId: room.id, startsAt: at("13:00"), endsAt: at("14:00") } },
    },
  });

  await context.addCookies([{ name: "locale", value: "en", url: baseURL! }]);
  await page.setViewportSize({ width: 1280, height: 960 });
  const range = `date=${day}&room=${room.id}`;
  await page.goto(`/calendar?view=week&${range}`);
  const otherContext = await browser.newContext({ storageState: await context.storageState() });
  const other = await otherContext.newPage();
  await other.goto(`/calendar?view=day&${range}`);
  const card = (tab: Page) => tab.locator(`[data-schedule-card] a[href="/events/${eventId}"]`);
  await expect(other.locator("html[data-hydrated]")).toBeAttached();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(card(page)).toContainText("09:00");
  await drag(page, card(page), 96);
  await expect(card(page)).toContainText("11:00");
  await expect(card(other)).toContainText("11:00");
  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(card(page)).toContainText("11:00");

  await drag(page, card(page), 96);
  const message = "The room is already booked by another event (13:00–14:00).";
  const error = card(page).locator("..").getByText(message, { exact: true });
  await expect(error).toBeVisible();
  await expect(card(page)).toHaveAccessibleDescription(message);
  await expect(card(page)).toContainText("11:00");
  await page.screenshot({
    path: testInfo.outputPath("calendar-conflict.png"),
    animations: "disabled",
  });

  const resize = other.getByRole("button", { name: `Change end time for ${title}` });
  await resize.focus();
  await drag(other, resize, 12);
  await expect(card(other)).toHaveAttribute("title", /12:15:00/);
  const move = other.getByRole("button", { name: `Move ${title}` });
  await move.focus();
  await move.press("Enter");
  await move.press("Alt+ArrowUp");
  await move.press("Escape");
  await expect(move).toBeFocused();
  await expect(card(other)).toContainText("11:00");
  const agent = await other.evaluate(
    async ({ modulePath, title }) => {
      const { uiAgent } = await import(modulePath);
      return {
        labels: uiAgent.snapshot().map(({ label }: { label: string }) => label),
        opened: (await uiAgent.act({ steps: [{ ref: `Move ${title}`, action: "press" }] })).ok,
      };
    },
    { modulePath: "/app/lib/ui-agent.client.ts", title },
  );
  expect(agent.labels).toEqual(
    expect.arrayContaining([`Move ${title}`, `Change end time for ${title}`]),
  );
  expect(agent.opened).toBe(true);
  await expect(move).toHaveAttribute("aria-pressed", "true");
  await move.press("Alt+ArrowUp");
  await move.press("Enter");
  await expect(card(other)).toContainText("10:45");

  const saved = await db.event.findUniqueOrThrow({
    where: { id: eventId },
    include: { rooms: true, allocations: true, serviceWindows: true },
  });
  expect(saved).toMatchObject({
    seriesId: null,
    startsAt: at("10:45"),
    endsAt: at("12:00"),
    rooms: [{ startsAt: at("10:45"), endsAt: at("12:00"), cancelled: false }],
    allocations: [{ startsAt: at("10:45"), endsAt: at("12:00"), cancelled: false }],
    serviceWindows: [{ startsAt: at("10:15"), endsAt: at("10:45") }],
  });
  await expect(db.event.findUnique({ where: { id: followingId } })).resolves.toMatchObject({
    seriesId: series.seriesId,
  });
  await expect(
    db.activityLog.count({ where: { entityId: eventId, action: "EventUpdated" } }),
  ).resolves.toBe(3);
  await otherContext.close();
});
