import { afterAll, describe, expect, it } from "vitest";
import { auth, requireUser } from "~/lib/auth.server";
import { db } from "~/lib/db.server";
import { ValidationError } from "~/lib/errors.server";
import { acceptInvite, createInvite, resolveInvite } from "~/domains/auth/users.queries.server";
import { resetTwoFactor } from "~/domains/auth/two-factor.server";
import { action as loginAction } from "~/routes/login/route";
import { action as twoFactorAction } from "~/routes/login_.two-factor/route";
import { action as accountAction } from "~/routes/_desktop.account/route";
import { totp } from "../../../../test/totp";

/**
 * TOTP two-factor authentication end to end through the route actions: enrolment
 * on the account page, the paused sign-in and its second step with an
 * authenticator code or a backup code, the admin reset and the optional admin
 * requirement. Each test signs in like a browser does, carrying the cookies the
 * previous response set.
 */
const ORIGIN = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const RUN = `tfa_${Date.now().toString(36)}`;
const PASSWORD = "two-factor-pw-123";
const ADMIN_ACTOR = {
  id: "test-admin",
  name: "2FA Admin",
  email: "admin@test.local",
  initials: "TA",
};
const userIds: string[] = [];

afterAll(async () => {
  for (const id of userIds) await db.user.delete({ where: { id } }).catch(() => undefined);
  await db.$disconnect();
});

function randomInitials(): string {
  return Array.from({ length: 4 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join("");
}

async function inviteUser(suffix: string, role: "MEMBER" | "ADMIN" = "MEMBER") {
  const email = `${RUN}_${suffix}@test.local`;
  const token = await createInvite(
    { email, name: `2FA ${suffix}`, initials: randomInitials(), role },
    { name: "Test" },
  );
  const user = await acceptInvite(await resolveInvite(token), PASSWORD);
  userIds.push(user.id);
  return user;
}

/** A browser's cookie jar, reduced to what these flows need. */
class Jar {
  private cookies = new Map<string, string>();
  take(response: Response | Headers): void {
    const headers = response instanceof Response ? response.headers : response;
    for (const line of headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const [name, ...rest] = pair!.split("=");
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || rest.join("=") === "") this.cookies.delete(name!.trim());
      else this.cookies.set(name!.trim(), rest.join("="));
    }
  }
  has(fragment: string): boolean {
    return [...this.cookies.keys()].some((name) => name.includes(fragment));
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function formRequest(path: string, jar: Jar, fields: Record<string, string>): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { cookie: jar.header(), origin: ORIGIN },
    body: new URLSearchParams(fields),
  });
}

/** Run an action the way React Router does: a thrown redirect is a response too. */
async function run<T>(fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

type ActionFn = (args: never) => Promise<unknown>;

async function post(
  handler: ActionFn,
  path: string,
  jar: Jar,
  fields: Record<string, string>,
): Promise<{ response?: Response; data?: Record<string, unknown> }> {
  const request = formRequest(path, jar, fields);
  const result = await run(() => handler({ request, params: {}, context: {} } as never));
  if (result instanceof Response) {
    jar.take(result);
    return { response: result };
  }
  // `data(value, init)` from react-router: unwrap its value and its headers.
  if (
    result &&
    typeof result === "object" &&
    "type" in result &&
    result.type === "DataWithResponseInit"
  ) {
    const wrapped = result as unknown as { data: Record<string, unknown>; init?: ResponseInit };
    if (wrapped.init?.headers) jar.take(new Headers(wrapped.init.headers));
    return { data: wrapped.data };
  }
  return { data: result as Record<string, unknown> };
}

async function sessionUser(jar: Jar) {
  const session = await auth.api.getSession({ headers: new Headers({ cookie: jar.header() }) });
  return session?.user ?? null;
}

async function signInWithPassword(
  email: string,
  next = "/",
): Promise<{ jar: Jar; location: string }> {
  const jar = new Jar();
  const { response } = await post(loginAction as ActionFn, "/login", jar, {
    email,
    password: PASSWORD,
    next,
  });
  expect(response?.status).toBe(302);
  return { jar, location: response!.headers.get("location")! };
}

/** Enrol through the account page; returns the setup key and the backup codes. */
async function enrol(email: string): Promise<{ secret: string; backupCodes: string[] }> {
  const { jar } = await signInWithPassword(email);
  const started = await post(accountAction as ActionFn, "/account", jar, {
    intent: "twoFactorStart",
    password: PASSWORD,
  });
  const enrolment = started.data!.enrolment as { secret: string; backupCodes: string[] };
  await post(accountAction as ActionFn, "/account", jar, {
    intent: "twoFactorConfirm",
    code: totp(enrolment.secret),
  });
  return enrolment;
}

describe("two-factor enrolment", () => {
  it("shows a QR code, the setup key and backup codes, and turns on only after a valid code", async () => {
    const user = await inviteUser("enrol");
    const { jar } = await signInWithPassword(user.email);

    const wrong = await post(accountAction as ActionFn, "/account", jar, {
      intent: "twoFactorStart",
      password: "not-the-password",
    });
    expect(wrong.data!.fieldErrors).toHaveProperty("password");

    const started = await post(accountAction as ActionFn, "/account", jar, {
      intent: "twoFactorStart",
      password: PASSWORD,
    });
    const enrolment = started.data!.enrolment as {
      qrSvg: string;
      secret: string;
      backupCodes: string[];
    };
    expect(enrolment.qrSvg).toContain("<svg");
    expect(enrolment.secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrolment.backupCodes).toHaveLength(10);
    // Started but not confirmed: sign-in is not gated yet.
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(
      false,
    );
    expect((await db.twoFactor.findUniqueOrThrow({ where: { userId: user.id } })).verified).toBe(
      false,
    );

    const badCode = await post(accountAction as ActionFn, "/account", jar, {
      intent: "twoFactorConfirm",
      code: "000000" === totp(enrolment.secret) ? "111111" : "000000",
    });
    expect(badCode.data!.fieldErrors).toHaveProperty("code");

    await post(accountAction as ActionFn, "/account", jar, {
      intent: "twoFactorConfirm",
      code: totp(enrolment.secret),
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(
      true,
    );
    expect((await db.twoFactor.findUniqueOrThrow({ where: { userId: user.id } })).verified).toBe(
      true,
    );
    // The rotated session cookie keeps this browser signed in.
    expect((await sessionUser(jar))?.id).toBe(user.id);
    const audit = await db.activityLog.findFirst({
      where: { action: "TwoFactorEnabled", entityType: "user", entityId: user.id },
    });
    expect(audit?.actorId).toBe(user.id);
  });

  it("keeps the secret and backup codes encrypted at rest", async () => {
    const user = await inviteUser("at-rest");
    const { secret, backupCodes } = await enrol(user.email);
    const row = await db.twoFactor.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.secret).not.toContain(secret);
    expect(row.backupCodes).not.toContain(backupCodes[0]!);
  });
});

describe("sign-in with two-factor", () => {
  it("signs an account without two-factor in with the password alone", async () => {
    const user = await inviteUser("plain");
    const { jar, location } = await signInWithPassword(user.email, "/rooms");
    expect(location).toBe("/rooms");
    expect((await sessionUser(jar))?.id).toBe(user.id);
  });

  it("asks an enrolled account for the code and creates no session before it", async () => {
    const user = await inviteUser("challenge");
    const { secret } = await enrol(user.email);
    const sessionsBefore = await db.session.count({ where: { userId: user.id } });

    const { jar, location } = await signInWithPassword(user.email, "/m/tasks");
    expect(location).toBe(`/login/two-factor?next=${encodeURIComponent("/m/tasks")}`);
    expect(await sessionUser(jar)).toBeNull();
    expect(await db.session.count({ where: { userId: user.id } })).toBe(sessionsBefore);

    const wrong = await post(twoFactorAction as ActionFn, "/login/two-factor", jar, {
      code: totp(secret) === "123456" ? "654321" : "123456",
      method: "totp",
      next: "/m/tasks",
    });
    expect(wrong.data!.error).toBeTruthy();
    expect(await sessionUser(jar)).toBeNull();

    const ok = await post(twoFactorAction as ActionFn, "/login/two-factor", jar, {
      code: totp(secret),
      method: "totp",
      next: "/m/tasks",
    });
    expect(ok.response?.status).toBe(302);
    expect(ok.response?.headers.get("location")).toBe("/m/tasks");
    expect((await sessionUser(jar))?.id).toBe(user.id);
  });

  it("sends a second step without a challenge back to the password step", async () => {
    const { response } = await post(twoFactorAction as ActionFn, "/login/two-factor", new Jar(), {
      code: "123456",
      method: "totp",
      next: "/",
    });
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toMatch(/^\/login\?twoFactorExpired=1/);
  });

  it("accepts each backup code once", async () => {
    const user = await inviteUser("backup");
    const { backupCodes } = await enrol(user.email);

    const first = await signInWithPassword(user.email);
    const used = await post(twoFactorAction as ActionFn, "/login/two-factor", first.jar, {
      code: backupCodes[0]!,
      method: "backup",
      next: "/",
    });
    expect(used.response?.headers.get("location")).toBe("/");
    expect((await sessionUser(first.jar))?.id).toBe(user.id);

    const second = await signInWithPassword(user.email);
    const reused = await post(twoFactorAction as ActionFn, "/login/two-factor", second.jar, {
      code: backupCodes[0]!,
      method: "backup",
      next: "/",
    });
    expect(reused.data!.error).toBeTruthy();
    expect(await sessionUser(second.jar)).toBeNull();
  });

  it("turns two-factor off from the account page with the password", async () => {
    const user = await inviteUser("disable");
    const { secret } = await enrol(user.email);
    const { jar } = await signInWithPassword(user.email);
    await post(twoFactorAction as ActionFn, "/login/two-factor", jar, {
      code: totp(secret),
      method: "totp",
      next: "/",
    });

    await post(accountAction as ActionFn, "/account", jar, {
      intent: "twoFactorDisable",
      password: PASSWORD,
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(
      false,
    );
    expect((await signInWithPassword(user.email)).location).toBe("/");
  });
});

describe("admin two-factor reset", () => {
  it("removes the authenticator in one audited transaction so the password signs in again", async () => {
    const user = await inviteUser("reset");
    await enrol(user.email);

    await resetTwoFactor(user.id, ADMIN_ACTOR);

    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorEnabled).toBe(
      false,
    );
    expect(await db.twoFactor.count({ where: { userId: user.id } })).toBe(0);
    const audit = await db.activityLog.findFirst({
      where: { action: "TwoFactorReset", entityType: "user", entityId: user.id },
    });
    expect(audit?.actorId).toBe(ADMIN_ACTOR.id);
    const { jar, location } = await signInWithPassword(user.email);
    expect(location).toBe("/");
    expect((await sessionUser(jar))?.id).toBe(user.id);
  });

  it("refuses to reset an account without two-factor and writes no audit row", async () => {
    const user = await inviteUser("reset-none");
    await expect(resetTwoFactor(user.id, ADMIN_ACTOR)).rejects.toBeInstanceOf(ValidationError);
    expect(
      await db.activityLog.count({ where: { action: "TwoFactorReset", entityId: user.id } }),
    ).toBe(0);
  });
});

describe("REQUIRE_ADMIN_TWO_FACTOR", () => {
  async function guard(jar: Jar, path: string): Promise<Response | null> {
    const result = await run(() =>
      requireUser(new Request(`${ORIGIN}${path}`, { headers: { cookie: jar.header() } })),
    );
    return result instanceof Response ? result : null;
  }

  it("holds an admin without two-factor on the account page while it is set", async () => {
    const admin = await inviteUser("admin", "ADMIN");
    const member = await inviteUser("member");
    const adminJar = (await signInWithPassword(admin.email)).jar;
    const memberJar = (await signInWithPassword(member.email)).jar;

    const previous = process.env.REQUIRE_ADMIN_TWO_FACTOR;
    process.env.REQUIRE_ADMIN_TWO_FACTOR = "true";
    try {
      expect((await guard(adminJar, "/rooms"))?.headers.get("location")).toBe(
        "/account?twoFactor=required",
      );
      expect(await guard(adminJar, "/account")).toBeNull();
      expect(await guard(memberJar, "/rooms")).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.REQUIRE_ADMIN_TWO_FACTOR;
      else process.env.REQUIRE_ADMIN_TWO_FACTOR = previous;
    }
    expect(await guard(adminJar, "/rooms")).toBeNull();
  });

  it("lets an enrolled admin through", async () => {
    const admin = await inviteUser("admin-enrolled", "ADMIN");
    const { secret } = await enrol(admin.email);
    const { jar } = await signInWithPassword(admin.email);
    await post(twoFactorAction as ActionFn, "/login/two-factor", jar, {
      code: totp(secret),
      method: "totp",
      next: "/",
    });
    process.env.REQUIRE_ADMIN_TWO_FACTOR = "true";
    try {
      expect(await guard(jar, "/rooms")).toBeNull();
    } finally {
      delete process.env.REQUIRE_ADMIN_TWO_FACTOR;
    }
  });
});
