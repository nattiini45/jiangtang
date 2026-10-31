import { randomInt } from "node:crypto";
import { test, expect } from "@playwright/test";
import { db } from "~/lib/db.server";
import { pseudonymizeUser } from "~/domains/auth/gdpr.server";
import { runPrefix } from "./run";

/**
 * Invitation-only access at the HTTP boundary.
 *
 * Test 1 uses a Playwright API context with EMPTY cookies/storageState — not
 * the authenticated admin fixture — and calls the real HTTP router.
 * Test 2 submits invalid credentials in an anonymous browser context and
 * requires a visible refusal, no redirect and no session.
 * Test 3 exercises the legitimate path: an admin creates an invite in the
 * browser, the invitee accepts it in a separate context with no storage, sets a
 * password and signs in.
 *
 * Cleanup: the invited user is removed through the app's audited erasure path
 * (`pseudonymizeUser`); only this run's synthetic emails/tokens are touched.
 */

const RUN = runPrefix();
const INVITEE_EMAIL = `${RUN}invitee@example.test`;
const ANON_EMAIL = `${RUN}anon-signup@example.test`;
const INVITEE_PASSWORD = "e2e-invite-pw-1";
const INVITEE_NAME = `${RUN}Invitee`;
// The invite form accepts letters only (users.schema.ts); a base36 suffix can
// contain digits, which made most runs fail before submitting.
const INITIALS_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const INVITEE_INITIALS =
  "E" +
  Array.from({ length: 4 }, () => INITIALS_LETTERS[randomInt(INITIALS_LETTERS.length)]).join("");

test.afterAll(async () => {
  const admin = await db.user.findFirst({ where: { email: process.env.ADMIN_EMAIL } });
  const actor = admin
    ? { id: admin.id, name: admin.name, initials: admin.initials }
    : { name: "e2e auth cleanup" };

  for (const email of [INVITEE_EMAIL, ANON_EMAIL]) {
    const user = await db.user.findUnique({ where: { email } });
    if (user) {
      // Existing audited domain path (Gdpr): scrub + deactivate, audit written.
      await pseudonymizeUser(actor, user.id);
    }
    // A refused signup leaves nothing; an unaccepted invite would leave its
    // Verification row. Tokens carry no audit history, so this scoped delete
    // only removes this suite's synthetic rows.
    await db.verification.deleteMany({ where: { identifier: email } });
  }
  await db.$disconnect();
});

test("anonymous HTTP signup is refused and creates no workspace session", async ({
  playwright,
  browser,
  baseURL,
}) => {
  const api = await playwright.request.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const response = await api.post("/api/auth/sign-up/email", {
      headers: { origin: baseURL! },
      data: { email: ANON_EMAIL, password: "e2e-anon-pw-1", name: "E2E Anonymous" },
    });
    // 404 is the disabledPaths rejection; a 403 would be the origin check.
    expect(response.status()).toBe(404);

    const state = await api.storageState();
    expect(state.cookies).toEqual([]);

    const session = await api.get("/api/auth/get-session");
    const body = (await session.json()) as { user?: unknown } | null;
    expect(body?.user ?? null).toBeNull();
  } finally {
    await api.dispose();
  }

  // A browser with no session state must land on the login shell, never the
  // workspace: the anonymous HTTP call issued no credentials to use.
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await anonymous.newPage();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Jiangtang" })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/login");
  } finally {
    await anonymous.close();
  }
});

test("invalid credentials show a refusal, stay on /login and create no session", async ({
  browser,
  baseURL,
}) => {
  // Anonymous context: the configured admin storageState must not apply, and
  // the refused submission must not leave a session behind either.
  const anonymous = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  try {
    const page = await anonymous.newPage();
    await page.goto("/login");
    await page.locator('input[name="email"]').fill(`${RUN}invalid-login@example.test`);
    await page.locator('input[name="password"]').fill("e2e-wrong-password-1");
    await page.getByRole("button", { name: "Anmelden", exact: true }).click();

    await expect(page.getByText("Ungültige Anmeldedaten.", { exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/login");
    await expect(
      page.getByRole("heading", { level: 1, name: "Übersicht", exact: true }),
    ).not.toBeVisible();

    const session = await anonymous.request.get("/api/auth/get-session");
    const body = (await session.json()) as { user?: unknown } | null;
    expect(body?.user ?? null).toBeNull();
  } finally {
    await anonymous.close();
  }
});

test("a legitimate invitation is accepted and signs the invitee in", async ({
  page,
  browser,
  baseURL,
}) => {
  // Admin creates the invite through the real UI.
  await page.goto("/admin/users/new");
  await page.locator('input[name="email"]').fill(INVITEE_EMAIL);
  await page.locator('input[name="name"]').fill(INVITEE_NAME);
  await page.locator('input[name="initials"]').fill(INVITEE_INITIALS);
  await page.locator('select[name="role"]').selectOption("MEMBER");
  await page.getByRole("button", { name: "Einladung erzeugen" }).click();
  await expect(page).toHaveURL(/\/admin\/users\?invited=/);

  const inviteLink = (
    await page.locator("code").filter({ hasText: "/accept-invite/" }).first().innerText()
  ).trim();
  const inviteUrl = new URL(inviteLink);
  expect(inviteUrl.origin).toBe(new URL(baseURL!).origin);
  expect(inviteUrl.pathname).toMatch(/^\/accept-invite\/[a-f0-9]{48}$/);

  // The invitee has no session of their own.
  const invitee = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const inviteePage = await invitee.newPage();
    await inviteePage.goto(inviteUrl.toString());
    await expect(
      inviteePage.getByRole("heading", { level: 1, name: "Einladung annehmen" }),
    ).toBeVisible();
    await inviteePage.locator('input[name="password"]').fill(INVITEE_PASSWORD);
    await inviteePage.locator('input[name="confirm"]').fill(INVITEE_PASSWORD);
    await inviteePage.getByRole("button", { name: "Konto aktivieren" }).click();
    await expect(inviteePage).toHaveURL(/\/login$/);

    await inviteePage.locator('input[name="email"]').fill(INVITEE_EMAIL);
    await inviteePage.locator('input[name="password"]').fill(INVITEE_PASSWORD);
    await inviteePage.getByRole("button", { name: "Anmelden", exact: true }).click();
    await expect(
      inviteePage.getByRole("heading", { level: 1, name: "Übersicht", exact: true }),
    ).toBeVisible();
    expect(new URL(inviteePage.url()).pathname).toBe("/");
  } finally {
    await invitee.close();
  }
});
