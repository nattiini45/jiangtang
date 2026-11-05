import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { redirect } from "react-router";
import { db } from "~/lib/db.server";

/**
 * Shortest password Better Auth accepts on sign-up and password change. The
 * production boot gate reads the same value, so a shorter ADMIN_PASSWORD fails
 * at boot instead of leaving the first admin uncreated.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** Longest password Better Auth accepts, at sign-in as well as when it is set. */
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Better Auth bootstrap. Email/password authentication; the Account table
 * already carries the OIDC columns. Our domain fields role/initials/isActive
 * are registered as additionalFields so they live on the same User row Better
 * Auth manages.
 *
 * No admin plugin here: it requires banned/banReason/banExpires columns we don't
 * model. Role checks and the active-user gate use our own role and isActive
 * fields, enforced in the exported helpers below.
 */
export const auth = betterAuth({
  appName: "Jiangtang",
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  database: prismaAdapter(db, { provider: "postgresql" }),
  // Invitation-only access: the HTTP router rejects public email sign-up
  // (disabledPaths is an onRequest hook; programmatic auth.api.signUpEmail used
  // by bootstrap and dev-seed is unaffected).
  disabledPaths: ["/sign-up/email"],
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxPasswordLength: MAX_PASSWORD_LENGTH,
  },
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
 * Requires a signed-in (active) user; redirects to /login otherwise, preserving
 * the attempted path as `?next=` so the user returns there after authenticating.
 */
export async function requireUser(request: Request): Promise<AuthUser> {
  const user = await getOptionalUser(request);
  if (!user) {
    const { pathname, search } = new URL(request.url);
    throw redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
  }
  if (user.isActive === false) {
    throw redirect("/login?deactivated=1");
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
