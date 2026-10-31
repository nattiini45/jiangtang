import { test, expect } from "@playwright/test";
import { db } from "~/lib/db.server";

/**
 * The pseudonymize page is a sibling route of the user edit page, not a child
 * (`users.$id_.erase` escapes the edit layout). Nested under it, the edit page
 * rendered in its place because it has no `<Outlet />`.
 */

test.afterAll(async () => {
  await db.$disconnect();
});

test("the edit page links to a pseudonymize page that renders its own body", async ({ page }) => {
  const member = await db.user.findFirstOrThrow({
    where: { email: { not: process.env.ADMIN_EMAIL } },
    orderBy: { id: "asc" },
  });

  await page.goto(`/admin/users/${member.id}`);
  await page.getByRole("link", { name: "Benutzer pseudonymisieren" }).click();

  await expect(page).toHaveURL(new RegExp(`/admin/users/${member.id}/erase$`));
  await expect(
    page.getByRole("heading", { level: 1, name: "Benutzer pseudonymisieren" }),
  ).toBeVisible();
  await expect(page.getByText("Diese Aktion ist unwiderruflich.")).toBeVisible();
  await expect(
    page.getByText(`Zur Bestätigung E-Mail-Adresse eingeben: ${member.email}`),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Pseudonymisieren bestätigen" })).toBeVisible();
  // The edit form must not be rendered on this page.
  await expect(page.getByRole("button", { name: "Speichern" })).toHaveCount(0);
});
