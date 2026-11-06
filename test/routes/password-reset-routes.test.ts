import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";
import { resolvePasswordReset } from "~/domains/auth/password-reset.server";

/**
 * The admin page that issues a password reset link, and the public page that
 * consumes it.
 */
const RUN = `pwroute_${Date.now().toString(36)}`;

const ADMIN: AuthUser = {
  id: null as unknown as string,
  name: "Reset Route Admin",
  email: `${RUN}_admin@test.local`,
  initials: "RRA",
  role: "ADMIN",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireRole: vi.fn(async () => ADMIN) };
});

const issueRoute = await import("~/routes/_desktop.admin.users.$id_.reset-password/route");
const resetRoute = await import("~/routes/reset-password.$token/route");

type Args<T extends (args: never) => unknown> = Parameters<T>[0];
let userId = "";

function post(url: string, body: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  return new Request(`https://av.example.test${url}`, { method: "POST", body: form });
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: `${RUN}@test.local`, name: "Reset Route User", initials: "RRU" },
  });
  userId = user.id;
});

afterAll(async () => {
  await db.verification.deleteMany({ where: { value: userId } });
  await db.account.deleteMany({ where: { userId } });
  await db.user.deleteMany({ where: { id: userId } });
  await db.$disconnect();
});

async function issueLink(): Promise<{ link: string; token: string }> {
  const result = await issueRoute.action({
    request: post(`/admin/users/${userId}/reset-password`),
    params: { id: userId },
  } as unknown as Args<typeof issueRoute.action>);
  const link = (result as { link?: string }).link ?? "";
  const token = link.split("/reset-password/")[1] ?? "";
  return { link, token };
}

describe("/admin/users/:id/reset-password", () => {
  it("shows which account the link is for", async () => {
    const data = await issueRoute.loader({
      request: new Request(`https://av.example.test/admin/users/${userId}/reset-password`),
      params: { id: userId },
    } as unknown as Args<typeof issueRoute.loader>);
    expect(data).toMatchObject({ user: { email: `${RUN}@test.local` } });
  });

  it("issues a one-time link on this installation's address", async () => {
    const { link, token } = await issueLink();
    expect(link).toMatch(/^https:\/\/av\.example\.test\/reset-password\/[0-9a-f]+$/);
    await expect(resolvePasswordReset(token)).resolves.toMatchObject({ userId });
  });
});

describe("/reset-password/:token", () => {
  it("answers an unknown link with a 404 message", async () => {
    await expect(
      resetRoute.loader({
        request: new Request("https://av.example.test/reset-password/0000"),
        params: { token: "0000" },
      } as unknown as Args<typeof resetRoute.loader>),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses mismatched passwords and keeps the link", async () => {
    const { token } = await issueLink();
    const result = await resetRoute.action({
      request: post(`/reset-password/${token}`, {
        token,
        password: "a-new-password-1",
        confirm: "something-else-2",
      }),
      params: { token },
    } as unknown as Args<typeof resetRoute.action>);
    expect(result).toMatchObject({ fieldErrors: { confirm: [expect.any(String)] } });
    await expect(resolvePasswordReset(token)).resolves.toMatchObject({ userId });
  });

  it("sets the password and sends the person to sign in", async () => {
    const { token } = await issueLink();
    const result = await resetRoute.action({
      request: post(`/reset-password/${token}`, {
        token,
        password: "a-new-password-1",
        confirm: "a-new-password-1",
      }),
      params: { token },
    } as unknown as Args<typeof resetRoute.action>);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("location")).toBe("/login?reset=1");
    await expect(resolvePasswordReset(token)).rejects.toThrow();
  });
});
