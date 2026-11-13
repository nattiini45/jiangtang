import { expect, test } from "@playwright/test";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runPrefix } from "./run";

const ids: string[] = [];
const invitationIds: string[] = [];

test.afterAll(async () => {
  await db.room.deleteMany({ where: { id: { in: ids } } });
  await db.invitation.deleteMany({ where: { id: { in: invitationIds } } });
  await db.$disconnect();
});

for (const locale of ["de", "en"] as const) {
  test(`invitation filter matches visible role and lifecycle in ${locale}`, async ({
    page,
    baseURL,
  }) => {
    const prefix = `${runPrefix()}invitation-filter-${locale}`;
    const invitation = await db.invitation.create({
      data: {
        name: prefix,
        email: `${prefix}@example.invalid`,
        initials: "IF",
        role: "MEMBER",
        expiresAt: new Date("2042-06-15T08:00:00Z"),
        revokedAt: new Date("2041-06-15T08:00:00Z"),
      },
    });
    invitationIds.push(invitation.id);
    await page.context().addCookies([{ name: "locale", value: locale, url: baseURL! }]);
    await page.goto("/admin/invitations");
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
    const filter = page.getByRole("textbox", { name: t(locale, "common.dataGrid.filterLabel") });
    for (const label of [
      t(locale, "auth.role.MEMBER"),
      t(locale, "admin.invitations.lifecycle.revoked", { date: "" }).trim(),
    ]) {
      await filter.fill(label);
      await expect(page.getByText(prefix, { exact: true })).toBeVisible();
    }
    if (locale === "de") {
      await filter.fill("revoked");
      await expect(page.getByText(prefix, { exact: true })).toHaveCount(0);
    }
  });

  test(`room filter matches the visible maintenance label in ${locale}`, async ({
    page,
    baseURL,
  }) => {
    const prefix = `${runPrefix()}filter-${locale}`;
    const maintenance = await db.room.create({
      data: { name: `${prefix} Hall`, slug: `${prefix}-hall`, status: "MAINTENANCE_NEEDED" },
    });
    const operational = await db.room.create({
      data: { name: `000 ${prefix} Empty`, slug: `${prefix}-empty`, status: "ALL_GOOD" },
    });
    ids.push(maintenance.id, operational.id);
    await page.context().addCookies([{ name: "locale", value: locale, url: baseURL! }]);
    await page.goto("/rooms");
    await expect(page.locator("html")).toHaveAttribute("data-hydrated", "true");
    const filter = page.getByRole("textbox", { name: t(locale, "common.dataGrid.filterLabel") });
    await filter.fill(locale === "de" ? "Wartung" : "Maintenance");
    const hall = page.locator(`a[href='/rooms/${maintenance.slug}']`);
    await expect(hall).toBeVisible();
    await expect(page.getByRole("row").filter({ has: hall })).toContainText(
      t(locale, "status.room.MAINTENANCE_NEEDED"),
    );
    await expect(page.locator(`a[href='/rooms/${operational.slug}']`)).toHaveCount(0);
    await filter.fill("MAINTENANCE_NEEDED");
    await expect(hall).toHaveCount(0);
    await filter.fill(operational.name);
    await expect(page.locator(`a[href='/rooms/${operational.slug}']`)).toBeVisible();
  });
}
