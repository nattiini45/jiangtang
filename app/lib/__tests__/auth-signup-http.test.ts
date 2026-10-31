import { afterAll, describe, expect, it } from "vitest";

/**
 * Public HTTP signup must be closed while trusted server-side registration
 * stays open. The reproduction goes through `auth.handler(new Request(...))` —
 * the same HTTP router Express mounts at /api/auth/* — not through `auth.api`,
 * because `disabledPaths` is applied in the router's onRequest hook and does not
 * affect the programmatic API used by bootstrap, dev-seed and invite acceptance.
 *
 * The origin is the configured one (BETTER_AUTH_URL in the test environment), not
 * a production URL. The same origin is used for the request URL and the Origin
 * header so a refusal cannot be mistaken for an origin-check rejection (that
 * would be 403; the disabled path is 404).
 */

const AUTH_ORIGIN = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
process.env.BETTER_AUTH_URL ??= AUTH_ORIGIN;

const { auth } = await import("~/lib/auth.server");
const { db } = await import("~/lib/db.server");

const createdUserIds: string[] = [];
const createdEmails: string[] = [];

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.session.deleteMany({ where: { userId: id } });
    await db.account.deleteMany({ where: { userId: id } });
    await db.user.deleteMany({ where: { id } });
  }
  for (const email of createdEmails) {
    await db.verification.deleteMany({ where: { identifier: email } });
  }
  await db.$disconnect();
});

function post(path: string, body: unknown): Request {
  return new Request(`${AUTH_ORIGIN}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
    body: JSON.stringify(body),
  });
}

async function rowsFor(
  email: string,
): Promise<{ users: number; accounts: number; sessions: number }> {
  const user = await db.user.findUnique({ where: { email } });
  if (!user) return { users: 0, accounts: 0, sessions: 0 };
  return {
    users: 1,
    accounts: await db.account.count({ where: { userId: user.id } }),
    sessions: await db.session.count({ where: { userId: user.id } }),
  };
}

describe("Anonymous HTTP signup", () => {
  it("is refused with no user/account/session, and sign-in afterwards fails", async () => {
    const email = `http_signup_${Date.now()}@jiangtang.local`;
    createdEmails.push(email);
    const password = "http-signup-pw-1";

    expect(await rowsFor(email)).toEqual({ users: 0, accounts: 0, sessions: 0 });

    const response = await auth.handler(
      post("/sign-up/email", { email, password, name: "HTTP Signup" }),
    );
    // 404 is the disabledPaths response; 403 would mean the origin check — a
    // different gate that would not prove the signup endpoint is closed.
    expect(response.status).toBe(404);

    expect(await rowsFor(email)).toEqual({ users: 0, accounts: 0, sessions: 0 });

    const signIn = await auth.handler(post("/sign-in/email", { email, password }));
    expect(signIn.ok).toBe(false);
    expect(signIn.status).toBe(401);
    expect(signIn.headers.get("set-cookie")).toBeNull();
  });

  it("is refused for trailing-slash and query variants of the same path", async () => {
    const variants = ["/sign-up/email/", "/sign-up/email?probe=1"];

    for (const [index, path] of variants.entries()) {
      const email = `http_variant_${Date.now()}_${index}@jiangtang.local`;
      createdEmails.push(email);
      const response = await auth.handler(
        post(path, { email, password: "http-variant-pw-1", name: `Variant ${index}` }),
      );
      expect(response.status, path).toBe(404);
      expect(await rowsFor(email), path).toEqual({ users: 0, accounts: 0, sessions: 0 });
    }
  });

  it("keeps trusted server-side registration working (auth.api, not public signup)", async () => {
    // This is server-side registration (bootstrap/dev-seed/invite-acceptance
    // path), deliberately labelled as such: it is not evidence that public
    // signup is open. `disabledPaths` only covers the HTTP router.
    const email = `http_trusted_${Date.now()}@jiangtang.local`;
    createdEmails.push(email);

    const { response } = await auth.api.signUpEmail({
      body: { email, password: "trusted-pw-1", name: "Trusted Server" },
      returnHeaders: true,
    });
    createdUserIds.push(response.user.id);

    const persisted = await db.user.findUnique({ where: { id: response.user.id } });
    expect(persisted?.email).toBe(email);
    expect(persisted?.role).toBe("MEMBER");
    expect(await db.account.count({ where: { userId: response.user.id } })).toBe(1);
  });
});
