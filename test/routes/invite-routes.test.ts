import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";
import { createInvite } from "~/domains/auth/users.queries.server";

/**
 * Action tests for the invitation routes: a clash with an existing account is
 * answered on the form, not with an error page or a 500.
 */
const RUN = `invroute_${Date.now().toString(36)}`;

const ADMIN: AuthUser = {
  id: null as unknown as string,
  name: "Invite Admin",
  email: `${RUN}_admin@test.local`,
  initials: "IA",
  role: "ADMIN",
  isActive: true,
} as AuthUser;

vi.mock("~/lib/auth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/auth.server")>();
  return { ...actual, requireRole: vi.fn(async () => ADMIN) };
});

const newInviteRoute = await import("~/routes/_desktop.admin.users.new/route");
const acceptRoute = await import("~/routes/accept-invite.$token/route");

const userIds: string[] = [];
const emails: string[] = [];

afterAll(async () => {
  // A failing run may have created an invitee's account; match those by email too.
  const owners = { OR: [{ id: { in: userIds } }, { email: { in: emails } }] };
  await db.account.deleteMany({ where: { user: owners } });
  await db.session.deleteMany({ where: { user: owners } });
  await db.user.deleteMany({ where: owners });
  await db.verification.deleteMany({ where: { identifier: { in: emails } } });
  await db.$disconnect();
});

function post(url: string, body: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  return new Request(`http://localhost${url}`, { method: "POST", body: form });
}

type ActionArgs<T extends (args: never) => unknown> = Parameters<T>[0];

describe("/admin/users/new", () => {
  it("answers an email that already has an account with a field error", async () => {
    const email = `${RUN}_taken@test.local`;
    const user = await db.user.create({ data: { email, name: "Taken", initials: "TKN" } });
    userIds.push(user.id);
    emails.push(email);

    const result = await newInviteRoute.action({
      request: post("/admin/users/new", { email, name: "Again", initials: "AGN", role: "MEMBER" }),
      params: {},
    } as unknown as ActionArgs<typeof newInviteRoute.action>);

    expect(result).toMatchObject({ fieldErrors: { email: [expect.stringMatching(/Konto/)] } });
  });
});

describe("/accept-invite/:token", () => {
  it("answers an initials clash with a form message and creates no account", async () => {
    const email = `${RUN}_invitee@test.local`;
    emails.push(email);
    const token = await createInvite(
      { email, name: "Invitee", initials: "ZQV", role: "MEMBER" },
      { name: "Test" },
    );
    const holder = await db.user.create({
      data: { email: `${RUN}_holder@test.local`, name: "Holder", initials: "ZQV" },
    });
    userIds.push(holder.id);

    const result = await acceptRoute.action({
      request: post(`/accept-invite/${token}`, {
        token,
        password: "a-valid-password-6",
        confirm: "a-valid-password-6",
      }),
      params: { token },
    } as unknown as ActionArgs<typeof acceptRoute.action>);

    expect(result).toMatchObject({ formErrors: [expect.stringMatching(/ZQV/)] });
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });

  it("refuses a password longer than sign-in accepts", async () => {
    const email = `${RUN}_long@test.local`;
    emails.push(email);
    const token = await createInvite(
      { email, name: "Long", initials: "LNG", role: "MEMBER" },
      { name: "Test" },
    );
    const password = "x".repeat(129);

    const result = await acceptRoute.action({
      request: post(`/accept-invite/${token}`, { token, password, confirm: password }),
      params: { token },
    } as unknown as ActionArgs<typeof acceptRoute.action>);

    expect(result).toMatchObject({ fieldErrors: { password: [expect.stringMatching(/128/)] } });
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
  });
});
