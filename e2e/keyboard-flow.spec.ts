import { test, expect, type Page } from "@playwright/test";
import { runPrefix } from "./run";
import { db } from "~/lib/db.server";

/**
 * Exit test — the whole palette flow runs keyboard-only. A
 * `sessionStorage` counter (survives the client-side navigations) records
 * every pointerdown/mousedown/touchstart; the suite asserts it stays at 0.
 *
 * Flow: Ctrl+K → „Aufgabe anlegen" → type a title → Enter → the task detail
 * page; then „Titel bearbeiten", „Mir zuweisen", and the two „Status setzen"
 * verbs — each asserted on the page, then in the DB at the end.
 */
const RUN = runPrefix();
const TITLE_CREATED = `${RUN}Tastaturfluss`;
const TITLE_EDITED = `${RUN}Tastaturfluss umbenannt`;
const POINTER_COUNT = "e2e-pointer-count";

async function pointerCount(page: Page): Promise<number> {
  return page.evaluate((key) => Number(sessionStorage.getItem(key) ?? "0"), POINTER_COUNT);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => {
    for (const type of ["pointerdown", "mousedown", "touchstart"]) {
      window.addEventListener(
        type,
        () => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? "0") + 1)),
        true,
      );
    }
  }, POINTER_COUNT);
});

test.afterAll(async () => {
  await db.$disconnect();
});

/**
 * Open the palette. On a freshly-loaded page React may still be hydrating —
 * a Ctrl+K before the window listener attaches is a no-op, so retry the chord
 * until the dialog appears (each retry re-toggles, so the poll converges).
 */
async function openPalette(page: Page) {
  const input = page.locator('input[role="combobox"]');
  await expect
    .poll(
      async () => {
        await page.keyboard.press("Control+k");
        await page.waitForTimeout(200);
        return await input.isVisible();
      },
      { timeout: 10_000, intervals: [400, 800, 1500] },
    )
    .toBe(true);
}

/** Open the palette, type a verb name, run the top row. */
async function runVerb(page: Page, label: string) {
  await openPalette(page);
  const input = page.locator('input[role="combobox"]');
  await expect(input).toBeFocused();
  await page.keyboard.type(label);
  await page.keyboard.press("Enter");
  await expect(input).toBeHidden();
}

/** A context verb submits a fetcher POST to the task route — wait for it. */
function waitForTaskPost(page: Page) {
  return page.waitForResponse(
    (r) => r.request().method() === "POST" && /\/tasks\/[^/?]+$/.test(new URL(r.url()).pathname),
    { timeout: 10_000 },
  );
}

test("keyboard-only palette flow: create, rename, assign, status ×2 — zero pointer events", async ({
  page,
}) => {
  const admin = await db.user.findFirstOrThrow({ where: { email: process.env.ADMIN_EMAIL } });

  await page.goto("/");
  await page.evaluate((key) => sessionStorage.removeItem(key), POINTER_COUNT);

  // 1. „Aufgabe anlegen" → /tasks/new, title autofocused, Enter submits.
  await runVerb(page, "Aufgabe anlegen");
  await expect(page).toHaveURL(/\/tasks\/new$/);
  const titleInput = page.locator('input[name="title"]');
  await expect(titleInput).toBeFocused();
  await page.keyboard.type(TITLE_CREATED);
  await page.keyboard.press("Enter");
  // `/tasks/new` itself matches /\/tasks\/[^/]+$/ — exclude it so the URL
  // assertion actually waits for the create-redirect, not the form page.
  await expect(page).toHaveURL(/\/tasks\/(?!new$)[^/]+$/);
  await expect(page.locator("h1")).toHaveText(TITLE_CREATED);

  // 2. „Titel bearbeiten" → opens the edit section, selects the title input.
  await runVerb(page, "Titel bearbeiten");
  await expect(titleInput).toBeFocused();
  await page.keyboard.type(TITLE_EDITED);
  const renamePost = waitForTaskPost(page);
  await page.keyboard.press("Enter");
  await renamePost;
  await expect(page.locator("h1")).toHaveText(TITLE_EDITED);

  // 3. „Mir zuweisen" → the actor joins the assignee set. The editor renders
  // one row per assignee plus a trailing blank row; the loader revalidation
  // lands a beat after the action response, so assert with retry.
  const assignPost = waitForTaskPost(page);
  await runVerb(page, "Mir zuweisen");
  await assignPost;
  const assigneeSelect = page.locator('select[name="assigneeUser"]');
  await expect(assigneeSelect).toHaveCount(2);
  expect(await assigneeSelect.first().inputValue()).toBe(admin.id);

  // 4. „Status setzen: In Arbeit" → the badge next to the title flips.
  const statusPost1 = waitForTaskPost(page);
  await runVerb(page, "Status setzen: In Arbeit");
  await statusPost1;
  await expect(page.locator("h1 + span")).toHaveText("In Arbeit");

  // 5. „Status setzen: Erledigt" → DONE.
  const statusPost2 = waitForTaskPost(page);
  await runVerb(page, "Status setzen: Erledigt");
  await statusPost2;
  await expect(page.locator("h1 + span")).toHaveText("Erledigt");

  // No pointer input anywhere in the flow.
  expect(await pointerCount(page)).toBe(0);

  // …and the DB agrees: edited title, admin assigned, status DONE.
  const task = await db.task.findFirstOrThrow({
    where: { title: TITLE_EDITED },
    include: { assignees: true },
  });
  expect(task.status).toBe("DONE");
  expect(task.assignees.map((a) => a.userId)).toContain(admin.id);
});

test("palette traps Tab focus and Escape restores the pre-open element", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((key) => sessionStorage.removeItem(key), POINTER_COUNT);

  // Focus a nav link first — Escape must hand focus back to it.
  const navLink = page.locator("nav a").first();
  await navLink.focus();
  await expect(navLink).toBeFocused();

  await openPalette(page);
  const input = page.locator('input[role="combobox"]');
  await expect(input).toBeFocused();

  // Tab forward a few times — focus must never leave the dialog.
  const dialog = page.locator('div[role="dialog"]');
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(inside).toBe(true);
  }
  // Shift+Tab backward — still trapped.
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Shift+Tab");
    const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(inside).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
  await expect(navLink).toBeFocused();
  expect(await pointerCount(page)).toBe(0);
});
