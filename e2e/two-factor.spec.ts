import { randomInt } from "node:crypto";
import { test, expect } from "@playwright/test";
import { db } from "~/lib/db.server";
import { acceptInvite, createInvite, resolveInvite } from "~/domains/auth/users.queries.server";
import { pseudonymizeUser } from "~/domains/auth/gdpr.server";
import { totp } from "../test/totp";
import { runPrefix } from "./run";

/**
 * Two-factor sign-in in a real browser: a member enrols from "Mein Konto" by
 * typing the code for the shown setup key, then signs in again from a fresh
 * browser that was heading for the mobile app. The password step must stop at
 * the code prompt, and the right code must land on the mobile page.
 *
 * The member is created and removed through the audited domain paths; only this
 * run's synthetic email is touched.
 */

const RUN = runPrefix();
const EMAIL = `${RUN}two-factor@example.test`;
const PASSWORD = "e2e-two-factor-pw-1";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const INITIALS = "T" + Array.from({ length: 4 }, () => LETTERS[randomInt(LETTERS.length)]).join("");

test.beforeAll(async () => {
  const token = await createInvite(
    { email: EMAIL, name: `${RUN}Two Factor`, initials: INITIALS, role: "MEMBER" },
    { name: "e2e two-factor setup" },
  );
  await acceptInvite(await resolveInvite(token), PASSWORD);
});

test.afterAll(async () => {
  const user = await db.user.findUnique({ where: { email: EMAIL } });
  if (user) await pseudonymizeUser({ name: "e2e two-factor cleanup" }, user.id);
  await db.$disconnect();
});

test("an enrolled account is asked for its code at sign-in, also on the way to /m", async ({
  browser,
  baseURL,
}) => {
  const first = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  let secret: string;
  try {
    const page = await first.newPage();
    await page.goto("/login?next=/account");
    await page.locator('input[name="email"]').fill(EMAIL);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);
    // The login form has a password field too; wait for the account page itself.
    await expect(
      page.getByRole("heading", { name: "Zwei-Faktor-Authentifizierung" }),
    ).toBeVisible();

    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Einrichten", exact: true }).click();
    await expect(
      page.getByRole("img", { name: "QR-Code für die Authenticator-App" }),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Backup-Codes" }).getByRole("listitem"),
    ).toHaveCount(10);
    secret = (await page.getByTestId("two-factor-secret").innerText()).trim();

    await page.locator('input[name="code"]').fill(totp(secret));
    await page.getByRole("button", { name: "Bestätigen und aktivieren" }).click();
    await expect(page.getByTestId("two-factor-status")).toHaveText("Aktiv.");
  } finally {
    await first.close();
  }

  const second = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const page = await second.newPage();
    await page.goto("/m/tasks");
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.locator('input[name="email"]').fill(EMAIL);
    await page.locator('input[name="password"]').fill(PASSWORD);
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();

    await expect(page).toHaveURL(/\/login\/two-factor\?next=/);
    await expect(page.getByRole("heading", { name: "Anmeldung bestätigen" })).toBeVisible();
    const session = await second.request.get("/api/auth/get-session");
    expect(((await session.json()) as { user?: unknown } | null)?.user ?? null).toBeNull();

    await page.getByLabel("Code", { exact: true }).fill(totp(secret));
    await page.getByRole("button", { name: "Bestätigen", exact: true }).click();
    await expect(page).toHaveURL(/\/m\/tasks$/);
    const signedIn = await second.request.get("/api/auth/get-session");
    expect(((await signedIn.json()) as { user?: { email?: string } } | null)?.user?.email).toBe(
      EMAIL,
    );
  } finally {
    await second.close();
  }
});
