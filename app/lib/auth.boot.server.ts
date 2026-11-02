import type { Express } from "express";
import { toNodeHandler } from "better-auth/node";
import { auth, MIN_PASSWORD_LENGTH } from "~/lib/auth.server";
import { bootstrapFirstAdmin } from "~/lib/auth-bootstrap.server";
import { db } from "~/lib/db.server";
import type { BootContext } from "~/server/boot";

/**
 * Mounts Better Auth's HTTP handler at /api/auth/* (discovered by the boot-loader,
 * runs before the React Router catch-all). MUST NOT sit behind a JSON body parser
 * (server.ts adds none). In development, seeds one admin so you can sign in.
 * The development defaults are unsafe for any public exposure.
 */

const DEFAULT_DEV_ADMIN_EMAIL = "admin@jiangtang.local";
const MIN_SECRET_LENGTH = 32;
const FEED_TOKEN_PLACEHOLDER = "generate-a-long-random-token-here";

/**
 * The dev-seed admin email, resolved at call time so a DEV_ADMIN_EMAIL
 * override is honoured — the same `??`-with-default semantics as the
 * DEV_ADMIN_PASSWORD read inside seedDevAdmin below. Exported so tests can
 * observe the resolved address without a database.
 */
export function resolveDevAdminEmail(): string {
  return process.env.DEV_ADMIN_EMAIL ?? DEFAULT_DEV_ADMIN_EMAIL;
}

/**
 * Refuses to boot in production with a guessable secret. The placeholders in
 * .env.example look like real values, so they are matched by prefix or by
 * equality. An unset ICAL_FEED_TOKEN is allowed: the feed then answers nothing.
 * A set ADMIN_PASSWORD that starts with the change-me placeholder is refused,
 * because that value is public in the repository. A set ADMIN_PASSWORD shorter
 * than MIN_PASSWORD_LENGTH is refused too: Better Auth would reject it, and the
 * bootstrap would then skip the admin with only a logged error, and boot would
 * continue without an admin. An unset one is allowed.
 */
export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH || secret.startsWith("change-me")) {
    throw new Error(
      `BETTER_AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters and must not be a placeholder. ` +
        "Generate one with `openssl rand -base64 48`.",
    );
  }
  const feedToken = env.ICAL_FEED_TOKEN;
  if (feedToken && (feedToken.length < MIN_SECRET_LENGTH || feedToken === FEED_TOKEN_PLACEHOLDER)) {
    throw new Error(
      `ICAL_FEED_TOKEN must be at least ${MIN_SECRET_LENGTH} characters and must not be a placeholder. ` +
        "Generate one with `openssl rand -hex 32`, or leave it empty to disable the feed.",
    );
  }
  const adminPassword = env.ADMIN_PASSWORD;
  if (adminPassword && adminPassword.startsWith("change-me")) {
    throw new Error(
      "ADMIN_PASSWORD must not be a placeholder. Set a strong password, or remove it once the first admin exists.",
    );
  }
  if (adminPassword && adminPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters. Set a longer password, or remove it once the first admin exists.`,
    );
  }
}

export async function register(app: Express, ctx: BootContext): Promise<void> {
  if (ctx.env === "production") assertProductionSecrets();

  app.all("/api/auth/*", toNodeHandler(auth));

  // The first-admin bootstrap runs before the dev seed, because an admin created
  // by the seed would make the bootstrap skip. Both admins are created on a fresh
  // development database with ADMIN_EMAIL set.
  await bootstrapFirstAdmin();

  if (ctx.env === "development") {
    await seedDevAdmin();
  }
}

async function seedDevAdmin(): Promise<void> {
  const email = resolveDevAdminEmail();
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) return;

  const password = process.env.DEV_ADMIN_PASSWORD ?? "jiangtang-admin";
  try {
    const { user } = await auth.api.signUpEmail({
      body: { email, password, name: "Dev Admin" },
    });
    // `initials` is @unique. When the bootstrap admin already holds "AD", the seed
    // admin is still promoted, only without the initials (as promoteToAdmin does).
    const clash = await db.user.findFirst({
      where: { initials: "AD", id: { not: user.id } },
      select: { id: true },
    });
    const data = { role: "ADMIN" as const, emailVerified: true };
    await db.user.update({
      where: { id: user.id },
      data: clash ? data : { ...data, initials: "AD" },
    });
    console.log("[seed] development admin created");
  } catch (error) {
    console.warn("[seed] dev admin seed skipped:", (error as Error).message);
  }
}
