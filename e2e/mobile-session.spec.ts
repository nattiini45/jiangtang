import { test, expect, type Page } from "@playwright/test";
import { runPrefix } from "./run";
import { db } from "~/lib/db.server";

/**
 * Expired session on the mobile capture page: with the session gone, a submit
 * is kept on the device and asks for a new sign-in instead of dropping the
 * capture. After signing in again the capture is sent exactly once (the
 * queue's `clientId` is the task's id) and the header badge clears.
 */
const RUN = runPrefix();

test.use({ viewport: { width: 390, height: 844 } });

type StoredCapture = {
  clientId: string;
  url: string;
  authRequired?: boolean;
  userId?: string;
  error?: string;
};

async function storedCaptures(page: Page): Promise<StoredCapture[]> {
  return await page.evaluate(
    () =>
      new Promise<StoredCapture[]>((resolve, reject) => {
        const open = indexedDB.open("jiangtang-offline", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result
            .transaction("captures", "readonly")
            .objectStore("captures")
            .getAll();
          req.onsuccess = () => resolve(req.result as StoredCapture[]);
          req.onerror = () => reject(req.error);
        };
      }),
  );
}

test("an expired session keeps the capture, asks for sign-in, and sends it once after it", async ({
  page,
}) => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set");
  const TITLE = `${RUN}Sitzung-Aufgabe-${Date.now().toString(36)}`;

  // Once the realtime stream opens, the shell revalidates the page's loaders.
  // That request must reach the server while the session still exists: with the
  // cookies already cleared, the /m loader would redirect the page to /login
  // before the form is filled.
  const revalidated = page.waitForResponse(
    (res) => res.request().method() === "GET" && res.url().includes("/m/tasks/new.data"),
  );
  await page.goto("/m/tasks/new");
  await expect(page.getByRole("heading", { name: "Aufgabe anlegen" })).toBeVisible();
  // A click before hydration is a native form POST, not the queue.
  await page.waitForSelector("html[data-hydrated]");
  await revalidated;

  // The session is gone: the next request meets requireUser's redirect to /login.
  await page.context().clearCookies();
  await page.locator("#title").fill(TITLE);
  await page.getByRole("button", { name: "Anlegen" }).click();

  // The capture is stored, so the form is cleared (a second tap would queue it
  // again), and the form itself confirms what happens next.
  await expect(page.locator("#title")).toHaveValue("");
  await expect(
    page.getByRole("status").filter({ hasText: "Gespeichert — wird nach der Anmeldung gesendet." }),
  ).toBeVisible();

  // The notice links back to this very page after sign-in, the badge to /m.
  await expect(page.getByText("Melde dich erneut an")).toBeVisible();
  await expect(page.getByRole("link", { name: "Anmelden", exact: true })).toHaveAttribute(
    "href",
    "/login?next=%2Fm%2Ftasks%2Fnew",
  );
  const badge = page.getByRole("link", { name: /^Anmelden, um die auf diesem Gerät/ });
  await expect(badge).toHaveAttribute("href", "/login?next=%2Fm");
  await expect(badge).toContainText("1");
  expect((await badge.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(await db.task.count({ where: { title: TITLE } })).toBe(0);

  const [queued] = await storedCaptures(page);
  expect(queued).toMatchObject({ url: "/m/tasks/new", authRequired: true });
  expect(queued.userId).toBeTruthy();
  expect(queued.error).toBeUndefined();

  // Sign in again through the form and return to /m.
  await badge.click();
  await page.waitForURL(/\/login\?next=%2Fm$/);
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form:has(input[name="email"]) button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname === "/m");

  await expect
    .poll(async () => db.task.count({ where: { title: TITLE } }), { timeout: 15_000 })
    .toBe(1);
  const tasks = await db.task.findMany({ where: { title: TITLE } });
  expect(tasks).toHaveLength(1);
  expect(tasks[0]?.id).toBe(queued.clientId);

  await expect(page.getByRole("link", { name: /^Anmelden, um die auf diesem Gerät/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole("status").filter({ hasText: /\d+/ })).toHaveCount(0);
  await expect.poll(async () => (await storedCaptures(page)).length).toBe(0);
});

test("the More sheet lists every mobile section as a flat single-level list", async ({ page }) => {
  await page.goto("/m");
  await page.waitForSelector("html[data-hydrated]");
  await page.getByRole("button", { name: "Mehr" }).click();
  const menu = page.getByRole("navigation", { name: "Weitere Bereiche" });
  // Flat: every section is a direct link row in the sheet, no nested group.
  for (const label of [
    "Räume",
    "Standorte",
    "Lager",
    "Veranstaltungen",
    "Projekte",
    "Notizen",
    "Zeiterfassung",
    "Board",
    "Suche",
    "Neue Aufgabe",
    "Neue Notiz",
  ]) {
    await expect(menu.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await menu.getByRole("link", { name: "Veranstaltungen", exact: true }).click();
  await expect(page).toHaveURL(/\/m\/events/);
  await expect(page.getByRole("heading", { name: "Veranstaltungen", level: 1 })).toBeVisible();
});
