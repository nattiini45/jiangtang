import { test, expect } from "@playwright/test";
import { db } from "~/lib/db.server";

const longName = "Alexandra-Maria Beispiel mit langem Familiennamen";
let invitationId: string;
let adminsWithoutTwoFactor: string[] = [];
test.beforeAll(async () => {
  adminsWithoutTwoFactor = (
    await db.user.findMany({
      where: { role: "ADMIN", isActive: true, twoFactorEnabled: false },
      select: { id: true },
    })
  ).map((user) => user.id);
  await db.user.updateMany({
    where: { id: { in: adminsWithoutTwoFactor } },
    data: { twoFactorEnabled: true },
  });
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
  await db.user.updateMany({
    where: { id: { in: adminsWithoutTwoFactor } },
    data: { twoFactorEnabled: false },
  });
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
        await expect(page).toHaveURL(/\/admin$/);
        for (const slug of ["", "users", "invitations", "search-index", "about"]) {
          const path = slug ? `/admin/${slug}` : "/admin";
          await page.locator(`nav a[href="${path}"]`).click();
          await expect(page).toHaveURL(new RegExp(`${path}$`));
          await expect(page.locator("main h1")).toBeVisible();
          await expect(page.locator(`nav a[href="${path}"]`)).toHaveAttribute(
            "aria-current",
            "page",
          );
          await expect(page.locator("nav a")).toHaveCount(7);
          await expect(page.locator('nav a[href="/admin/structure"]')).toBeInViewport();
          if (!slug) {
            await expect(page.locator('main a[href="/admin/about"]')).toBeInViewport();
            await expect(page.locator('main a[href="/admin/invitations"]')).toBeInViewport();
            await expect(
              page.getByRole("heading", {
                name: locale === "en" ? "Detected problems" : "Erkannte Probleme",
              }),
            ).toBeVisible();
            await expect(
              page.getByText(locale === "en" ? "No problems detected" : "Keine Probleme erkannt", {
                exact: true,
              }),
            ).toBeVisible();
            await page.screenshot({
              path: testInfo.outputPath(`overview-${locale}-${density}-${theme}-clear.png`),
            });
            const job = await db.searchIndexJob.create({
              data: {
                sourceType: "note",
                sourceId: "admin-overview-test",
                op: "embed",
                nextAttemptAt: new Date("2099-01-01T00:00:00Z"),
              },
            });
            try {
              await page.reload();
              await expect(
                page.getByText(locale === "en" ? "Risk" : "Risiko", { exact: true }),
              ).toBeVisible();
              await page.screenshot({
                path: testInfo.outputPath(`overview-${locale}-${density}-${theme}-problems.png`),
              });
            } finally {
              await db.searchIndexJob.delete({ where: { id: job.id } });
            }
          }
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
