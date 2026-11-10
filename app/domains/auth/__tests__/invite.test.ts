import { afterAll, describe, expect, it } from "vitest";
import { auth, getOptionalUser, requireUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { createInvite, resolveInvite, acceptInvite } from "~/domains/auth/users.queries.server";
import { ValidationError } from "~/lib/errors.server";

/** The configured synthetic auth origin (BETTER_AUTH_URL in the test environment). */
const AUTH_ORIGIN = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");

function signInRequest(email: string, password: string): Request {
  return new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: AUTH_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
}

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
    await db.invitation.deleteMany({ where: { email: email.toLowerCase() } });
  }
  await db.$disconnect();
});

const ACTOR = { id: "system", name: "Test", email: "t@t", initials: "TT" };

describe("invite flow", () => {
  it("createInvite → resolveInvite → acceptInvite yields an active, role-correct user", async () => {
    const email = `invite_${Date.now()}@jiangtang.local`;
    createdEmails.push(email);

    const token = await createInvite(
      { email, name: "Invitee", initials: "in", role: "ADMIN" },
      ACTOR,
    );
    expect(token).toBeTruthy();

    const invite = await resolveInvite(token);
    expect(invite.email).toBe(email);
    expect(invite.role).toBe("ADMIN");
    expect(invite.initials).toBe("IN"); // uppercased

    const { id } = await acceptInvite(invite, "a-valid-password-1");
    createdUserIds.push(id);

    const persisted = await db.user.findUnique({ where: { id } });
    expect(persisted).not.toBeNull();
    expect(persisted!.role).toBe("ADMIN");
    expect(persisted!.initials).toBe("IN");
    expect(persisted!.emailVerified).toBe(false);

    // An accepted invite can log in through the public sign-in endpoint
    // (public sign-UP is disabled; sign-in stays open).
    const signIn = await auth.handler(signInRequest(email, "a-valid-password-1"));
    expect(signIn.ok).toBe(true);
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).toContain("session_token");
    const signedIn = await getOptionalUser(new Request(`${AUTH_ORIGIN}/`, { headers: { cookie } }));
    expect(signedIn?.email).toBe(email);

    // The invite is single-use: re-resolving the same token must fail.
    await expect(resolveInvite(token)).rejects.toThrow();
  });

  it("rejects an unknown invite token", async () => {
    await expect(
      resolveInvite("0123456789abcdef0123456789abcdef0123456789abcdef"),
    ).rejects.toThrow();
  });

  it("server-side registration ignores role/isActive input (not public signup policy)", async () => {
    // Re-assert the guarantee on this path: role/isActive are input:false.
    // This is the trusted server-side path; public HTTP signup is
    // separately in auth-signup-http.test.ts.
    const email = `esc_${Date.now()}@jiangtang.local`;
    const { response } = await auth.api.signUpEmail({
      body: {
        email,
        password: "some-password-2",
        name: "Esc",
        // These must be IGNORED — a self-signup payload cannot grant admin.
        ...({ role: "ADMIN", isActive: false } as unknown as object),
      } as never,
      returnHeaders: true,
    });
    createdUserIds.push(response.user.id);
    createdEmails.push(email);

    const persisted = await db.user.findUnique({ where: { id: response.user.id } });
    expect(persisted!.role).toBe("MEMBER"); // default, not the injected ADMIN
    expect(persisted!.isActive).toBe(true); // default, not the injected false
  });

  it("a deactivated user is redirected by requireUser", async () => {
    const email = `deact_${Date.now()}@jiangtang.local`;
    const token = await createInvite(
      { email, name: "Deact", initials: "de", role: "MEMBER" },
      ACTOR,
    );
    createdEmails.push(email);
    const password = "another-pw-3";
    const { id } = await acceptInvite(await resolveInvite(token), password);
    createdUserIds.push(id);

    const signIn = await auth.handler(signInRequest(email, password));
    expect(signIn.ok).toBe(true);
    const cookie = (signIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    await db.user.update({ where: { id }, data: { isActive: false } });

    const request = new Request(`${AUTH_ORIGIN}/`, { headers: { cookie } });
    const optional = await getOptionalUser(request);
    expect(optional?.isActive).toBe(false);

    // requireUser must redirect a deactivated session, not serve the page.
    let redirected: Response | null = null;
    try {
      await requireUser(request);
    } catch (thrown) {
      redirected = thrown as Response;
    }
    expect(redirected?.status).toBe(302);
    expect(redirected?.headers.get("location")).toBe("/login?deactivated=1");
  });
});

/** Captures the ValidationError a call throws, failing the test when it throws anything else. */
async function validationErrorOf(run: () => Promise<unknown>): Promise<ValidationError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof ValidationError) return e;
    throw e;
  }
  throw new Error("expected a ValidationError");
}

describe("invite clashes", () => {
  it("refuses to invite an email that already has an account, in any letter case", async () => {
    const stamp = Date.now();
    const email = `taken_${stamp}@jiangtang.local`;
    const existing = await db.user.create({ data: { email, name: "Taken", initials: `TK` } });
    createdUserIds.push(existing.id);
    createdEmails.push(email, email.toUpperCase());

    const error = await validationErrorOf(() =>
      createInvite(
        { email: email.toUpperCase(), name: "Again", initials: "ag", role: "MEMBER" },
        ACTOR,
      ),
    );
    expect(error.fieldErrors.email?.[0]).toMatch(/bereits ein Konto/);
    expect(
      await db.verification.count({ where: { identifier: { in: [email, email.toUpperCase()] } } }),
    ).toBe(0);
  });

  it("replaces an older pending invite whose email was stored with other letter case", async () => {
    const stamp = Date.now();
    const email = `legacy_${stamp}@jiangtang.local`;
    const typed = `Legacy_${stamp}@Jiangtang.local`;
    createdEmails.push(email, typed);
    // Invites created before emails were lower-cased kept the email as typed.
    const stale = await db.verification.create({
      data: {
        identifier: typed,
        value: JSON.stringify({
          token: `stale${stamp}`,
          email: typed,
          initials: "OLD",
          role: "ADMIN",
        }),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await createInvite({ email, name: "Legacy", initials: "lgy", role: "MEMBER" }, ACTOR);
    expect(await db.verification.findUnique({ where: { id: stale.id } })).toBeNull();
  });

  it("refuses initials that another user already holds", async () => {
    const stamp = Date.now();
    const holder = await db.user.create({
      data: { email: `holder_${stamp}@jiangtang.local`, name: "Holder", initials: "QXZ" },
    });
    createdUserIds.push(holder.id);
    const email = `newcomer_${stamp}@jiangtang.local`;
    createdEmails.push(email);

    const error = await validationErrorOf(() =>
      createInvite({ email, name: "Newcomer", initials: "qxz", role: "MEMBER" }, ACTOR),
    );
    expect(error.fieldErrors.initials?.[0]).toMatch(/QXZ/);
    expect(await db.verification.count({ where: { identifier: email } })).toBe(0);
  });

  it("refuses acceptance when the email got an account after the invite, without a 500", async () => {
    const stamp = Date.now();
    const email = `late_${stamp}@jiangtang.local`;
    createdEmails.push(email);
    const token = await createInvite(
      { email, name: "Late", initials: "lt", role: "MEMBER" },
      ACTOR,
    );
    const invite = await resolveInvite(token);
    const meanwhile = await db.user.create({ data: { email, name: "Meanwhile" } });
    createdUserIds.push(meanwhile.id);

    const error = await validationErrorOf(() => acceptInvite(invite, "a-valid-password-4"));
    expect(error.formErrors[0]).toMatch(/bereits ein Konto/);
    expect(await db.user.count({ where: { email } })).toBe(1);
    expect(await db.account.count({ where: { userId: meanwhile.id } })).toBe(0);
  });

  it("creates nothing when the invited initials were taken after the invite", async () => {
    const stamp = Date.now();
    const email = `clash_${stamp}@jiangtang.local`;
    createdEmails.push(email);
    const token = await createInvite(
      { email, name: "Clash", initials: "wqy", role: "ADMIN" },
      ACTOR,
    );
    const invite = await resolveInvite(token);
    const holder = await db.user.create({
      data: { email: `wqy_${stamp}@jiangtang.local`, name: "Holder", initials: "WQY" },
    });
    createdUserIds.push(holder.id);

    const error = await validationErrorOf(() => acceptInvite(invite, "a-valid-password-5"));
    expect(error.formErrors[0]).toMatch(/WQY/);
    // No orphan account: neither the user nor a credential exists for the invitee.
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
    expect(await db.account.count({ where: { user: { email } } })).toBe(0);
    // The invite stays usable once the admin sorts out the clash.
    await expect(resolveInvite(token)).resolves.toMatchObject({ email });
  });
});
