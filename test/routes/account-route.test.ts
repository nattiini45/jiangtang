import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { acceptInvite, createInvite, resolveInvite } from "~/domains/auth/users.queries.server";

/**
 * The signed-in account page: a member changes their own password with the
 * current one, and every other session of theirs is signed out. Runs against
 * the real Better Auth handler with real session cookies.
 */
const AUTH_ORIGIN = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const RUN = `acct_${Date.now().toString(36)}`;
const EMAIL = `${RUN}@test.local`;
const OLD_PASSWORD = "old-password-123";
const NEW_PASSWORD = "new-password-456";

const accountRoute = await import("~/routes/_desktop.account/route");

let userId = "";

async function signIn(password: string): Promise<Response> {
  return auth.handler(
    new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
      body: JSON.stringify({ email: EMAIL, password }),
    }),
  );
}

async function sessionCookie(password: string): Promise<string> {
  const res = await signIn(password);
  expect(res.ok).toBe(true);
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

function post(cookie: string, body: Record<string, string>): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  return new Request(`${AUTH_ORIGIN}/account`, {
    method: "POST",
    headers: { cookie, origin: AUTH_ORIGIN },
    body: form,
  });
}

type Args<T extends (args: never) => unknown> = Parameters<T>[0];
const callAction = (request: Request) =>
  accountRoute.action({ request, params: {} } as unknown as Args<typeof accountRoute.action>);

beforeAll(async () => {
  const token = await createInvite(
    { email: EMAIL, name: "Account Tester", initials: "ACT", role: "MEMBER" },
    { name: "Test" },
  );
  ({ id: userId } = await acceptInvite(await resolveInvite(token), OLD_PASSWORD));
});

afterAll(async () => {
  await db.session.deleteMany({ where: { userId } });
  await db.account.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

describe("/account", () => {
  it("requires a signed-in user", async () => {
    await expect(
      accountRoute.loader({
        request: new Request(`${AUTH_ORIGIN}/account`),
        params: {},
      } as unknown as Args<typeof accountRoute.loader>),
    ).rejects.toMatchObject({ status: 302 });
  });

  it("shows the signed-in user's own details", async () => {
    const cookie = await sessionCookie(OLD_PASSWORD);
    const data = await accountRoute.loader({
      request: new Request(`${AUTH_ORIGIN}/account`, { headers: { cookie } }),
      params: {},
    } as unknown as Args<typeof accountRoute.loader>);
    expect(data).toMatchObject({ user: { email: EMAIL, initials: "ACT" } });
  });

  it("refuses a wrong current password and keeps the old one", async () => {
    const cookie = await sessionCookie(OLD_PASSWORD);
    const result = await callAction(
      post(cookie, {
        currentPassword: "not-the-password",
        newPassword: NEW_PASSWORD,
        confirm: NEW_PASSWORD,
      }),
    );
    expect(result).toMatchObject({
      fieldErrors: { currentPassword: [expect.stringMatching(/Passwort/)] },
    });
    expect((await signIn(OLD_PASSWORD)).ok).toBe(true);
  });

  it("refuses a new password shorter than the minimum", async () => {
    const cookie = await sessionCookie(OLD_PASSWORD);
    const result = await callAction(
      post(cookie, { currentPassword: OLD_PASSWORD, newPassword: "short", confirm: "short" }),
    );
    expect(result).toMatchObject({ fieldErrors: { newPassword: [expect.any(String)] } });
    expect((await signIn(OLD_PASSWORD)).ok).toBe(true);
  });

  it("answers an over-long current password with a field error, not a 500", async () => {
    const cookie = await sessionCookie(OLD_PASSWORD);
    const result = await callAction(
      post(cookie, {
        currentPassword: "z".repeat(129),
        newPassword: NEW_PASSWORD,
        confirm: NEW_PASSWORD,
      }),
    );
    expect(result).toMatchObject({ fieldErrors: { currentPassword: [expect.any(String)] } });
  });

  it("refuses a new password longer than sign-in accepts", async () => {
    const cookie = await sessionCookie(OLD_PASSWORD);
    const long = "y".repeat(129);
    const result = await callAction(
      post(cookie, { currentPassword: OLD_PASSWORD, newPassword: long, confirm: long }),
    );
    expect(result).toMatchObject({ fieldErrors: { newPassword: [expect.stringMatching(/128/)] } });
  });

  it("changes the password, keeps this browser signed in and signs out the others", async () => {
    const other = await sessionCookie(OLD_PASSWORD);
    const mine = await sessionCookie(OLD_PASSWORD);

    const result = await callAction(
      post(mine, {
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirm: NEW_PASSWORD,
      }),
    );

    // The route answers with a fresh session cookie for this browser.
    const init = (result as { init?: ResponseInit | null }).init;
    const setCookie = new Headers(init?.headers).get("set-cookie") ?? "";
    expect(setCookie).toContain("session_token");
    expect((result as { data?: unknown }).data).toMatchObject({ changed: true });

    expect((await signIn(OLD_PASSWORD)).ok).toBe(false);
    expect((await signIn(NEW_PASSWORD)).ok).toBe(true);

    const otherSession = await auth.api.getSession({ headers: new Headers({ cookie: other }) });
    expect(otherSession).toBeNull();
    const freshCookie = setCookie.split(";")[0] ?? "";
    const freshSession = await auth.api.getSession({
      headers: new Headers({ cookie: freshCookie }),
    });
    expect(freshSession?.user.email).toBe(EMAIL);

    const audit = await db.activityLog.findFirst({
      where: { action: "PasswordChanged", entityId: userId },
    });
    expect(audit?.actorId).toBe(userId);
  });
});
