import { test, expect } from "@playwright/test";

/**
 * `/welcome` is off unless the operator sets `LANDING_PAGE_ENABLED=1`, and the e2e server
 * runs with the default. So the only public page is the sign-in page: an anonymous visitor
 * who opens `/welcome` or `/` ends up on `/login`, and the sign-in page does not link to the
 * landing. The default e2e storage state is signed in, so the anonymous cases use a fresh
 * context. The enabled case is covered by `test/routes/welcome-route.test.ts`.
 */

test.use({ viewport: { width: 1280, height: 800 } });

test("signed-out /welcome and / go to the sign-in page", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  for (const path of ["/welcome", "/"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login(\?|$)/);
  }
  await expect(page.getByRole("link", { name: "Was ist Jiangtang?" })).toHaveCount(0);
  await context.close();
});

test("signed-in /welcome ends on the dashboard", async ({ page }) => {
  await page.goto("/welcome");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
});
