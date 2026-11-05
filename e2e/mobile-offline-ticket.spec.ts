import { test, expect, type Page } from "@playwright/test";
import { runPrefix } from "./run";
import { db } from "~/lib/db.server";

/**
 * Offline ticket entry on `/m`, the PWA's primary action. It uses the same
 * capture queue as `/m/tasks/new`: offline, the entry queues; back online, the
 * replay creates the ticket exactly once (the queue's clientId is its id).
 * The queue holds form fields only, so an entry with photos is never queued
 * silently: the form keeps the photos until the person retries or explicitly
 * saves the entry offline without them.
 */
const RUN = runPrefix();

test.use({ viewport: { width: 390, height: 844 } });

// A 1×1 PNG, enough for the photo input and the upload route.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** `/m` is an index route: its action's data URL is `/m.data?index`. */
const isEntryPost = (url: URL) => url.pathname === "/m.data";

async function openEntry(page: Page) {
  await page.goto("/m");
  await expect(page.getByRole("heading", { name: "Eintrag erfassen" })).toBeVisible();
  // Before hydration a click is a native form POST, which offline is a browser
  // error page rather than the queue.
  await page.waitForSelector("html[data-hydrated]");
}

/** Abort the capture POST at the fetch layer — `setOffline` is not deterministic. */
async function goOffline(page: Page) {
  await page.route(isEntryPost, (route) =>
    route.request().method() === "POST" ? route.abort("internetdisconnected") : route.continue(),
  );
}

async function goOnline(page: Page) {
  await page.unroute(isEntryPost);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

const submitButton = (page: Page) => page.getByRole("button", { name: "Eintrag erfassen" });

test("an offline ticket queues, replays once online, and the badge clears", async ({ page }) => {
  const TITLE = `${RUN}Offline-Ticket-${Date.now().toString(36)}`;
  await openEntry(page);
  await goOffline(page);

  await page.locator('input[name="title"]').fill(TITLE);
  await submitButton(page).click();

  await expect(page.getByText("Offline gespeichert")).toBeVisible();
  await expect(page.getByText(`${TITLE} — ausstehend`)).toBeVisible();
  // Cleared, so a second tap cannot queue the same entry twice.
  await expect(page.locator('input[name="title"]')).toHaveValue("");
  await expect(page.getByRole("status").filter({ hasText: "1" }).first()).toBeVisible();
  expect(await db.ticket.count({ where: { title: TITLE } })).toBe(0);

  await goOnline(page);
  await expect
    .poll(async () => db.ticket.count({ where: { title: TITLE } }), { timeout: 15_000 })
    .toBe(1);
  await expect(page.getByText(`${TITLE} — ausstehend`)).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: /^\d+$/ })).toHaveCount(0);
});

test("an offline ticket with a photo is not queued until the person drops the photo", async ({
  page,
}) => {
  const TITLE = `${RUN}Offline-Foto-${Date.now().toString(36)}`;
  await openEntry(page);
  await goOffline(page);

  await page.locator('input[name="title"]').fill(TITLE);
  await page.locator('input[type="file"]').setInputFiles({
    name: "defekt.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await submitButton(page).click();

  // Not stored: the form, its title and its photo stay, with the choice offered.
  await expect(page.getByText("Nicht gesendet: keine Verbindung.", { exact: false })).toBeVisible();
  await expect(page.locator('input[name="title"]')).toHaveValue(TITLE);
  await expect(page.getByText(`${TITLE} — ausstehend`)).toHaveCount(0);

  await page.getByRole("button", { name: "Offline ohne Fotos speichern" }).click();
  await expect(page.getByText("Offline gespeichert")).toBeVisible();
  await expect(page.getByText(`${TITLE} — ausstehend`)).toBeVisible();

  await goOnline(page);
  await expect
    .poll(async () => db.ticket.count({ where: { title: TITLE } }), { timeout: 15_000 })
    .toBe(1);
  const ticket = await db.ticket.findFirstOrThrow({ where: { title: TITLE } });
  expect(await db.attachment.count({ where: { ticketId: ticket.id } })).toBe(0);
});

test("online, the entry is created and its photo uploaded", async ({ page }) => {
  const TITLE = `${RUN}Online-Foto-${Date.now().toString(36)}`;
  await openEntry(page);

  await page.locator('input[name="title"]').fill(TITLE);
  await page.locator('input[type="file"]').setInputFiles({
    name: "defekt.png",
    mimeType: "image/png",
    buffer: PNG,
  });
  await submitButton(page).click();

  await expect(page).toHaveURL(/\/m\/rooms$/, { timeout: 15_000 });
  const ticket = await db.ticket.findFirstOrThrow({ where: { title: TITLE } });
  expect(await db.attachment.count({ where: { ticketId: ticket.id } })).toBe(1);
});
