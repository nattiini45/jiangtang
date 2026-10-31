import { test, expect } from "@playwright/test";
import { runPrefix } from "./run";
import { db } from "~/lib/db.server";

/**
 * Offline capture: on a phone-sized viewport, submit `/m/tasks/new` while
 * offline → the entry queues (UI notice + shell badge); back online, the
 * replay posts it — and because the queue's `clientId` becomes the task's id,
 * the DB holds the row exactly once and the badge clears.
 */
const RUN = runPrefix();

test.use({ viewport: { width: 390, height: 844 } });

test("offline capture queues, replays once online, badge clears", async ({ page }) => {
  // Unique per invocation — `--repeat-each` iterations share RUN and the DB
  // (global teardown only sweeps at suite end), so a passed iteration's row
  // must not read as this iteration's premature create.
  const TITLE = `${RUN}Offline-Aufgabe-${Date.now().toString(36)}`;
  await page.goto("/m/tasks/new");
  await expect(page.getByRole("heading", { name: "Aufgabe anlegen" })).toBeVisible();
  // The shell marks hydration done — a click before that hits the native
  // form POST, which offline turns into a browser error page, not the queue.
  await page.waitForSelector("html[data-hydrated]");

  // Deterministic "network down": abort the capture POST at the fetch layer.
  // context.setOffline is NOT reliable here — Chromium may still dispatch the
  // request on a pooled keep-alive connection, so the row could exist AND the
  // queued UI show (ambiguous boundary), or the POST could fully succeed.
  // The queue targets the route's `.data` URL (a data request); a POST to the
  // surface path would render the document instead of returning the action.
  await page.route("**/m/tasks/new.data", (route) =>
    route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue(),
  );
  await page.locator("#title").fill(TITLE);
  await page.getByRole("button", { name: "Anlegen" }).click();

  await expect(page.getByText("Offline gespeichert")).toBeVisible();
  // The shell badge counts queued captures.
  await expect(page.getByRole("status").filter({ hasText: "1" }).first()).toBeVisible();
  expect(await db.task.count({ where: { title: TITLE } })).toBe(0);

  await page.unroute("**/m/tasks/new.data");
  // The `online` event triggers replayQueue — dispatch it, then wait for the
  // row, then the badge.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect
    .poll(async () => db.task.count({ where: { title: TITLE } }), { timeout: 15_000 })
    .toBe(1);
  await expect(page.getByRole("status").filter({ hasText: /\d+/ })).toHaveCount(0);

  const tasks = await db.task.findMany({ where: { title: TITLE } });
  expect(tasks).toHaveLength(1);
});
