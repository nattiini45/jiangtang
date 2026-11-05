import { test, expect, type Page } from "@playwright/test";
import { db } from "~/lib/db.server";

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
  // Scoped to the credentials form: the language switcher also renders submit buttons here.
  await page.locator('form:has(input[name="email"]) button[type="submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** Whether a signed-in cache holds an entry for this path (the cache the page just filled, not the install-time precache). */
function isCached(page: Page, path: string) {
  return page.evaluate(
    async ([prefix, target]) => {
      for (const name of await caches.keys()) {
        if (name.startsWith(prefix) && (await (await caches.open(name)).match(target))) return true;
      }
      return false;
    },
    [SHELL_PREFIX, path] as const,
  );
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
  // The install-time precache already fills the cache with /m/ and /m/offline, so wait for the
  // page the visit above should have stored.
  await expect.poll(() => isCached(page, "/m/tasks"), { timeout: 15_000 }).toBe(true);
  const { name: userName } = await db.user.findFirstOrThrow({
    where: { email: credentials().email },
    select: { name: true },
  });

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
  await expect(page.locator("body")).not.toContainText(userName);
  await context.setOffline(false);
});
