import { afterAll, describe, expect, it } from "vitest";
import { auth } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { action, loader } from "~/routes/_desktop.admin.invitations/route";

const email = `invitation-access-${crypto.randomUUID()}@example.test`;

afterAll(async () => {
  await db.session.deleteMany({ where: { user: { email } } });
  await db.account.deleteMany({ where: { user: { email } } });
  await db.user.deleteMany({ where: { email } });
});

describe("admin-only invitations", () => {
  it("rejects anonymous and member reads and writes using the real auth guard", async () => {
    const origin = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
    const signedUp = await auth.api.signUpEmail({
      body: { email, name: "Synthetic member", password: "a-valid-password-1" },
      returnHeaders: true,
    });
    const cookie = signedUp.headers.get("set-cookie")!.split(";")[0]!;
    for (const handler of [loader, action]) {
      const method = handler === action ? "POST" : "GET";
      await expect(
        handler({
          request: new Request(`${origin}/admin/invitations`, { method }),
          params: {},
          context: {},
        } as never),
      ).rejects.toMatchObject({ status: 302 });
      await expect(
        handler({
          request: new Request(`${origin}/admin/invitations`, {
            method,
            headers: { cookie, origin },
          }),
          params: {},
          context: {},
        } as never),
      ).rejects.toMatchObject({ status: 403 });
    }
  });
});
