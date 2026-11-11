import { test, expect } from "@playwright/test";
import { db } from "~/lib/db.server";

const longName = "Alexandra-Maria Beispiel mit langem Familiennamen";
let invitationId: string;
test.beforeAll(async () => {
  invitationId = (
    await db.invitation.create({
      data: {
        email: "admin-shell@example.test",
        name: longName,
        initials: "AM",
        role: "MEMBER",
        expiresAt: new Date("2099-01-01T00:00:00Z"),
      },
    })
  ).id;
});
test.afterAll(async () => {
  if (invitationId) await db.invitation.delete({ where: { id: invitationId } });
  await db.$disconnect();
});

for (const locale of ["en", "de"])
  for (const density of ["comfortable", "compact"])
    for (const theme of ["light", "dark"]) {
      test(`admin pages fit 1280px: ${locale} ${density} ${theme}`, async ({
        page,
        context,
        baseURL,
      }, testInfo) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await context.addCookies(
          Object.entries({ locale, density, theme }).map(([name, value]) => ({
            name,
            value,
            url: baseURL!,
          })),
        );
        await page.goto("/");
        await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
        await page.locator('nav a[href="/admin"]').click();
        await expect(page).toHaveURL(/\/admin\/users$/);
        for (const slug of ["users", "invitations", "search-index", "about"]) {
          await page.locator(`nav a[href="/admin/${slug}"]`).click();
          await expect(page).toHaveURL(new RegExp(`/admin/${slug}$`));
          await expect(page.locator("main h1")).toBeVisible();
          await expect(page.locator(`nav a[href="/admin/${slug}"]`)).toHaveAttribute(
            "aria-current",
            "page",
          );
          await expect(page.locator("nav a")).toHaveCount(5);
          expect(
            await page.evaluate(
              () =>
                Array.from(document.querySelectorAll("main, main *")).filter(
                  (e) =>
                    e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === "auto",
                ).length,
            ),
          ).toBe(0);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          if (slug === "users" || slug === "invitations") {
            await expect(page.locator('main a[href="/admin/users/new"]')).toBeInViewport();
            await expect(page.locator("main button").last()).toBeInViewport();
          }
          if (slug === "invitations")
            await expect(page.getByTitle(longName, { exact: true })).toBeVisible();
          if (
            (density === "comfortable" && theme === "light") ||
            (locale === "de" && density === "compact" && theme === "dark")
          )
            await page.screenshot({ path: testInfo.outputPath(`${slug}-${locale}.png`) });
        }
        await page.locator('nav a[href="/"]').click();
        await expect(page.locator('nav a[href="/admin"]')).toBeVisible();
      });
    }
