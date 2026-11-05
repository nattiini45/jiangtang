import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * The failed-sign-in throttle on both entry points: the login form's action
 * (`auth.api.signInEmail`) and Better Auth's HTTP endpoint (`auth.handler`).
 * Both run the same Better Auth hook, so a lockout earned on one holds on the
 * other. The throttle is module-global, so every test starts from `reset()`.
 *
 * The origin matches BETTER_AUTH_URL so an origin rejection (403) cannot be
 * mistaken for the throttle (429).
 */

const AUTH_ORIGIN = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
process.env.BETTER_AUTH_URL ??= AUTH_ORIGIN;

const { auth } = await import("~/lib/auth.server");
const { db } = await import("~/lib/db.server");
const { loginThrottle, LOGIN_MAX_EMAIL_FAILURES, LOGIN_MAX_IP_FAILURES } =
  await import("~/lib/login-throttle.server");
const { t } = await import("~/i18n");
const { action } = await import("~/routes/login/route");

const RUN = `throttle_${Date.now().toString(36)}`;
const PASSWORD = "throttle-correct-pw-1";
const userIds: string[] = [];

async function makeUser(label: string): Promise<string> {
  const email = `${RUN}_${label}@jiangtang.local`;
  const { user } = await auth.api.signUpEmail({
    body: { email, password: PASSWORD, name: `Throttle ${label}` },
  });
  userIds.push(user.id);
  return email;
}

afterAll(async () => {
  for (const id of userIds) {
    await db.session.deleteMany({ where: { userId: id } });
    await db.account.deleteMany({ where: { userId: id } });
    await db.user.deleteMany({ where: { id } });
  }
  await db.$disconnect();
});

beforeEach(() => {
  loginThrottle.reset();
});

type FormResult = Awaited<ReturnType<typeof action>>;

async function submitForm(
  email: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<FormResult> {
  const body = new URLSearchParams({ email, password, next: "/" });
  const request = new Request(`${AUTH_ORIGIN}/login`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept-language": "en",
      ...headers,
    },
    body,
  });
  return action({ request, params: {}, context: {} } as never);
}

/** The 429 the form answers: react-router `data(...)` with a status. */
function refusal(result: FormResult): { status: number; error: string; retryAfter: string | null } {
  const r = result as unknown as {
    type?: string;
    data: { error: string };
    init: { status: number; headers?: Record<string, string> };
  };
  expect(r.type).toBe("DataWithResponseInit");
  return {
    status: r.init.status,
    error: r.data.error,
    retryAfter: new Headers(r.init.headers).get("retry-after"),
  };
}

function isRedirect(result: FormResult): boolean {
  return result instanceof Response && result.status === 302 && result.headers.has("set-cookie");
}

function isInvalidCredentials(result: FormResult): boolean {
  return (
    !(result instanceof Response) &&
    (result as { error?: string }).error === t("en", "auth.login.invalidCredentials")
  );
}

function post(email: string, password: string, headers: Record<string, string> = {}): Request {
  return new Request(`${AUTH_ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: AUTH_ORIGIN, ...headers },
    body: JSON.stringify({ email, password }),
  });
}

describe("login form action", () => {
  it("refuses the correct password with 429 after too many failures for the email", async () => {
    const email = await makeUser("form");
    // Sign-up auto-signs in once; the refused sign-in must not add another.
    const sessionsBefore = await db.session.count({ where: { user: { email } } });
    for (let i = 0; i < LOGIN_MAX_EMAIL_FAILURES; i++) {
      expect(isInvalidCredentials(await submitForm(email, "wrong-password-1"))).toBe(true);
    }

    const locked = refusal(await submitForm(email, PASSWORD));
    expect(locked.status).toBe(429);
    expect(locked.error).toMatch(/^Too many failed sign-in attempts\. Try again in \d+ min\.$/);
    expect(Number(locked.retryAfter)).toBeGreaterThan(0);
    expect(Number(locked.retryAfter)).toBeLessThanOrEqual(15 * 60);
    expect(await db.session.count({ where: { user: { email } } })).toBe(sessionsBefore);
  });

  it("treats an unknown email exactly like a known one", async () => {
    const known = await makeUser("known");
    const unknown = `${RUN}_nobody@jiangtang.local`;
    const results = [];
    for (const email of [known, unknown]) {
      for (let i = 0; i < LOGIN_MAX_EMAIL_FAILURES; i++)
        await submitForm(email, "wrong-password-1");
      results.push(refusal(await submitForm(email, "wrong-password-1")));
    }
    // Retry-After differs by the second or so the two runs took.
    expect({ ...results[0], retryAfter: null }).toEqual({ ...results[1], retryAfter: null });
    expect(results[0]!.status).toBe(429);
  });

  it("counts case and whitespace variants of an email as one key", async () => {
    const email = await makeUser("variants");
    for (let i = 0; i < LOGIN_MAX_EMAIL_FAILURES; i++) {
      await submitForm(i % 2 ? email.toUpperCase() : `  ${email} `, "wrong-password-1");
    }
    expect(refusal(await submitForm(email, PASSWORD)).status).toBe(429);
  });

  it("resets the counter on a successful sign-in", async () => {
    const email = await makeUser("reset");
    for (let i = 0; i < LOGIN_MAX_EMAIL_FAILURES - 1; i++) await submitForm(email, "wrong-pw-1");
    expect(isRedirect(await submitForm(email, PASSWORD))).toBe(true);

    // Had the counter survived, the second wrong password would already be refused.
    for (let i = 0; i < LOGIN_MAX_EMAIL_FAILURES - 1; i++) {
      expect(isInvalidCredentials(await submitForm(email, "wrong-password-1"))).toBe(true);
    }
    expect(isRedirect(await submitForm(email, PASSWORD))).toBe(true);
  });

  it("limits an IP across different emails, and only that IP", async () => {
    const email = await makeUser("ip");
    const attacker = { "x-forwarded-for": "6.6.6.6, 203.0.113.9" };
    for (let i = 0; i < LOGIN_MAX_IP_FAILURES; i++) {
      await submitForm(`${RUN}_guess${i}@jiangtang.local`, "wrong-password-1", attacker);
    }
    expect(refusal(await submitForm(email, PASSWORD, attacker)).status).toBe(429);
    // A client-supplied left-most entry cannot dodge the limit.
    const spoofed = { "x-forwarded-for": "1.2.3.4, 203.0.113.9" };
    expect(refusal(await submitForm(email, PASSWORD, spoofed)).status).toBe(429);
    // Another client is unaffected.
    expect(
      isRedirect(await submitForm(email, PASSWORD, { "x-forwarded-for": "203.0.113.10" })),
    ).toBe(true);
  });
});

describe("Better Auth HTTP sign-in", () => {
  it("refuses with 429 and Retry-After, and the lockout is shared with the form", async () => {
    const email = await makeUser("http");
    for (let i = 0; i < LOGIN_MAX_EMAIL_FAILURES; i++) {
      const response = await auth.handler(post(email, "wrong-password-1"));
      expect(response.status).toBe(401);
    }

    const locked = await auth.handler(post(email, PASSWORD));
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(locked.headers.get("set-cookie")).toBeNull();

    expect(refusal(await submitForm(email, PASSWORD)).status).toBe(429);
  });

  it("signs in normally below the limit and clears the counter", async () => {
    const email = await makeUser("httpok");
    for (let i = 0; i < LOGIN_MAX_EMAIL_FAILURES - 1; i++) {
      await auth.handler(post(email, "wrong-password-1"));
    }
    const ok = await auth.handler(post(email, PASSWORD));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toContain("session_token");

    for (let i = 0; i < LOGIN_MAX_EMAIL_FAILURES - 1; i++) {
      expect((await auth.handler(post(email, "wrong-password-1"))).status).toBe(401);
    }
  });

  it("uses the same right-most X-Forwarded-For entry for the IP key", async () => {
    const email = await makeUser("httpip");
    const attacker = { "x-forwarded-for": "6.6.6.6, 203.0.113.20" };
    for (let i = 0; i < LOGIN_MAX_IP_FAILURES; i++) {
      await auth.handler(post(`${RUN}_g${i}@jiangtang.local`, "wrong-password-1", attacker));
    }
    expect((await auth.handler(post(email, PASSWORD, attacker))).status).toBe(429);
    expect((await auth.handler(post(email, PASSWORD))).status).toBe(200);
  });
});
