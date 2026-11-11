import { readConfig } from "~/lib/config.server";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { redirect } from "react-router";
import { db } from "~/lib/db.server";
import {
  clientIpFromHeaders,
  loginThrottle,
  normalizeLoginEmail,
  type LoginAttempt,
} from "~/lib/login-throttle.server";

/**
 * Shortest password Better Auth accepts on sign-up and password change. The
 * production boot gate reads the same value, so a shorter ADMIN_PASSWORD fails
 * at boot instead of leaving the first admin uncreated.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** Longest password Better Auth accepts, at sign-in as well as when it is set. */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Who is signing in, for the failed-sign-in throttle. Both entry points reach
 * it: the HTTP router passes the request headers, and the login form forwards
 * its X-Forwarded-For header to `auth.api.signInEmail`.
 */
function loginAttemptOf(ctx: {
  body?: unknown;
  headers?: Headers;
  request?: Request;
}): LoginAttempt {
  const body = ctx.body as { email?: unknown } | undefined;
  return {
    email: normalizeLoginEmail(body?.email),
    ip: clientIpFromHeaders(ctx.headers ?? ctx.request?.headers),
  };
}

/**
 * Better Auth bootstrap. Email/password authentication; the Account table
 * already carries the OIDC columns. Our domain fields role/initials/isActive
 * are registered as additionalFields so they live on the same User row Better
 * Auth manages.
 *
 * No admin plugin here: it requires banned/banReason/banExpires columns we don't
 * model. Role checks and the active-user gate use our own role and isActive
 * fields, enforced in the exported helpers below.
 *
 * The twoFactor plugin adds optional TOTP with backup codes. Its sign-in hook
 * turns a correct password of an enrolled user into a short-lived challenge
 * cookie instead of a session; `/login/two-factor` completes it.
 */
export const auth = betterAuth({
  appName: "Jiangtang",
  secret: readConfig("BETTER_AUTH_SECRET"),
  baseURL: readConfig("BETTER_AUTH_URL"),
  database: prismaAdapter(db, { provider: "postgresql" }),
  // Invitation-only access: the HTTP router rejects public email sign-up
  // (disabledPaths is an onRequest hook; programmatic auth.api.signUpEmail used
  // by bootstrap and dev-seed is unaffected).
  disabledPaths: ["/sign-up/email"],
  // Hooks run for the HTTP router and for `auth.api.*` calls alike. Better
  // Auth's own rate limiter lives in the router only, so it never sees the
  // login form, and it would not limit failures per account anyway.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      const decision = loginThrottle.begin(loginAttemptOf(ctx));
      if (decision.allowed) return;
      throw new APIError(
        "TOO_MANY_REQUESTS",
        { message: "Too many failed sign-in attempts", code: "TOO_MANY_FAILED_SIGN_INS" },
        { "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)) },
      );
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      // The attempt was already counted as a failure in `before`; a result that
      // is not an error means the password was right.
      const returned = ctx.context.returned;
      if (returned === undefined || isAPIError(returned)) return;
      loginThrottle.succeeded(loginAttemptOf(ctx));
    }),
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxPasswordLength: MAX_PASSWORD_LENGTH,
  },
  plugins: [twoFactor()],
  user: {
    additionalFields: {
      // input:false → cannot be self-assigned at sign-up (no privilege escalation).
      role: { type: "string", required: false, defaultValue: "MEMBER", input: false },
      // Set by admins through the audited user-management path (and at invite
      // acceptance), which validates it. input:false keeps it out of the Better
      // Auth update path, where the initials rules would not apply.
      initials: { type: "string", required: false, input: false },
      isActive: { type: "boolean", required: false, defaultValue: true, input: false },
      // Set by admins on the user edit form only (input: false → no
      // self-assignment at sign-up), stored in minutes.
      weeklyCapacityMinutes: { type: "number", required: false, input: false },
    },
  },
});

export type AppRole = "ADMIN" | "MEMBER";

/**
 * The session user, widened with our domain additionalFields so call sites read
 * `user.role` / `user.isActive` / `user.initials` without inline casts.
 * The single boundary cast lives in `getOptionalUser`.
 */
export type AuthUser = typeof auth.$Infer.Session.user & {
  role: AppRole;
  twoFactorEnabled: boolean;
  initials: string | null;
  isActive: boolean;
  weeklyCapacityMinutes: number | null;
};

/**
 * Turn an untrusted `next` value into a safe, local redirect target.
 * Only same-origin absolute paths are allowed; protocol-relative (`//host`)
 * and backslash variants (which browsers normalize to `//`) are rejected to
 * prevent open redirects. Control characters (tabs, CR, LF, etc.) are stripped
 * first — browsers strip them when parsing a `Location` header, so a value like
 * `/\t/evil.com` would otherwise pass the prefix checks here but collapse to
 * `//evil.com` on the client. Anything that still isn't a safe local path after
 * stripping falls back to "/".
 */
export function sanitizeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  // Strip all C0 control characters (0x00-0x1F) and DEL (0x7F), then trim.
  // eslint-disable-next-line no-control-regex -- matching control chars is the point
  const stripped = raw.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!stripped.startsWith("/") || stripped.startsWith("//") || stripped.startsWith("/\\")) {
    return "/";
  }
  return stripped;
}

/** Returns the signed-in user or null. */
export async function getOptionalUser(request: Request): Promise<AuthUser | null> {
  const session = await auth.api.getSession({ headers: request.headers });
  return (session?.user as AuthUser | undefined) ?? null;
}

/**
 * Whether admins must use two-factor authentication. Set
 * REQUIRE_ADMIN_TWO_FACTOR=true once every admin can enrol; an admin without it
 * is then held on the account page until they do.
 */
export function adminTwoFactorRequired(env?: NodeJS.ProcessEnv): boolean {
  return readConfig("REQUIRE_ADMIN_TWO_FACTOR", env);
}

/** Where an admin who still has to enrol is sent, and the paths they may still load. */
const TWO_FACTOR_ENROLMENT_PATH = "/account";
const ENROLMENT_PATHS = new Set([TWO_FACTOR_ENROLMENT_PATH, `${TWO_FACTOR_ENROLMENT_PATH}.data`]);

/**
 * Requires a signed-in (active) user; redirects to /login otherwise, preserving
 * the attempted path as `?next=` so the user returns there after authenticating.
 */
export async function requireUser(request: Request): Promise<AuthUser> {
  const user = await getOptionalUser(request);
  const { pathname, search } = new URL(request.url);
  if (!user) {
    throw redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
  }
  if (user.isActive === false) {
    throw redirect("/login?deactivated=1");
  }
  if (
    user.role === "ADMIN" &&
    !user.twoFactorEnabled &&
    adminTwoFactorRequired() &&
    !ENROLMENT_PATHS.has(pathname)
  ) {
    throw redirect(`${TWO_FACTOR_ENROLMENT_PATH}?twoFactor=required`);
  }
  return user;
}

/**
 * Requires a role. MEMBER = any signed-in user; ADMIN = role === "ADMIN".
 * Throws a 403 Response for an under-privileged user.
 */
export async function requireRole(request: Request, role: AppRole): Promise<AuthUser> {
  const user = await requireUser(request);
  if (role === "ADMIN" && user.role !== "ADMIN") {
    throw new Response("Forbidden", { status: 403 });
  }
  return user;
}
