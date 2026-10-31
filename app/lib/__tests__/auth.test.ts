import { afterAll, describe, expect, it } from "vitest";
import { auth, getOptionalUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";

/**
 * Integration test: Better Auth (email/password) + the Prisma adapter + our schema
 * (incl. role/initials/isActive additionalFields) actually work together at
 * runtime — and the frozen `getOptionalUser` resolves a session cookie to a user.
 * Also de-risks the zod peer-dep warning (better-call wants zod 4; we ship zod 3).
 */

const createdUserIds: string[] = [];

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.session.deleteMany({ where: { userId: id } });
    await db.account.deleteMany({ where: { userId: id } });
    await db.user.deleteMany({ where: { id } });
  }
  await db.$disconnect();
});

function cookieFromSetCookie(setCookie: string | null): string {
  // Take the first "name=value" pair of the Set-Cookie header.
  return (setCookie ?? "").split(";")[0] ?? "";
}

describe("Better Auth email/password", () => {
  it("signs up a user and round-trips the session through getOptionalUser", async () => {
    const email = `auth_${Date.now()}@jiangtang.local`;
    const { response, headers } = await auth.api.signUpEmail({
      body: { email, password: "test-password-123", name: "Auth Tester" },
      returnHeaders: true,
    });
    expect(response.user.email).toBe(email);
    createdUserIds.push(response.user.id);

    // Default additionalFields applied.
    expect((response.user as { role?: string }).role).toBe("MEMBER");
    expect((response.user as { isActive?: boolean }).isActive).toBe(true);

    // The signup auto-signed in → a session cookie was set. Resolve it.
    const cookie = cookieFromSetCookie(headers.get("set-cookie"));
    expect(cookie).toContain("session_token");

    const request = new Request("http://localhost/", { headers: { cookie } });
    const user = await getOptionalUser(request);
    expect(user?.email).toBe(email);
  });

  it("persists a hashed password in the Account table (not plaintext)", async () => {
    const email = `auth2_${Date.now()}@jiangtang.local`;
    const { response } = await auth.api.signUpEmail({
      body: { email, password: "another-password-456", name: "Two" },
      returnHeaders: true,
    });
    createdUserIds.push(response.user.id);

    const account = await db.account.findFirst({ where: { userId: response.user.id } });
    expect(account).not.toBeNull();
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toContain("another-password-456");
  });
});
