import { test, expect, type Page } from "@playwright/test";

/**
 * The installed app caches signed-in pages by URL. Signing out must not leave them behind for
 * whoever opens the app next on the same device, online or offline.
 *
 * Uses its own session (not the shared admin storage state): signing out ends that session, and
 * the other specs rely on theirs.
 */
test.use({
  storageState: { cookies: [], origins: [] },
  serviceWorkers: "allow",
  viewport: { width: 390, height: 844 },
});

const SHELL_PREFIX = "jiangtang-shell-";

function credentials() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set");
  return { email, password };
}

async function signIn(page: Page) {
  const { email, password } = credentials();
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** Total entries across the worker's signed-in caches. */
function shellEntryCount(page: Page) {
  return page.evaluate(async (prefix) => {
    let total = 0;
    for (const name of await caches.keys()) {
      if (name.startsWith(prefix)) total += (await (await caches.open(name)).keys()).length;
    }
    return total;
  }, SHELL_PREFIX);
}

test("signing out empties the cached signed-in pages and offline shows only the placeholder", async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.goto("/m/");
  await page.waitForSelector("html[data-hydrated]");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto("/m/tasks");
  await expect.poll(() => shellEntryCount(page), { timeout: 15_000 }).toBeGreaterThan(0);

  // The layout's sign-out is a POST to /logout; it ends only this test's own session.
  const out = await page.request.post("/logout", { maxRedirects: 0 });
  expect(out.status()).toBeLessThan(400);
  await page.goto("/login");
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect.poll(() => shellEntryCount(page)).toBe(0);

  await context.setOffline(true);
  await page.goto("/m/tasks");
  await expect(page.getByRole("heading", { name: "Offline" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(credentials().email);
  await context.setOffline(false);
});
