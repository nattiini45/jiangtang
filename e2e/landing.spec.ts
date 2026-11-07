import { test, expect } from "@playwright/test";

/**
 * `/welcome` is the one public page besides login: anonymous visitors get the
 * landing, signed-in users are bounced to the dashboard. The default e2e
 * storage state is signed in, so the anonymous case uses a fresh context.
 */

test.use({ viewport: { width: 1280, height: 800 } });

test("signed-out /welcome renders the landing with a sign-in CTA", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/welcome");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Der All-in-One-Arbeitsplatz für AV- und Facility-Teams",
    }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Anmelden" })).toHaveAttribute("href", "/login");
  // The final URL stays /welcome — no redirect to /login.
  expect(new URL(page.url()).pathname).toBe("/welcome");
  await context.close();
});

test("signed-in /welcome redirects to the dashboard", async ({ page }) => {
  await page.goto("/welcome");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Übersicht" })).toBeVisible();
});

test("the login page links to the landing", async ({ browser }) => {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.getByRole("link", { name: "Was ist Jiangtang?" })).toHaveAttribute(
    "href",
    "/welcome",
  );
  await context.close();
});
