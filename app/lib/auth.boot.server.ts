import type { Express } from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "~/lib/auth.server";
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

/**
 * The dev-seed admin email, resolved at call time so a DEV_ADMIN_EMAIL
 * override is honoured — the same `??`-with-default semantics as the
 * DEV_ADMIN_PASSWORD read inside seedDevAdmin below. Exported so tests can
 * observe the resolved address without a database.
 */
export function resolveDevAdminEmail(): string {
  return process.env.DEV_ADMIN_EMAIL ?? DEFAULT_DEV_ADMIN_EMAIL;
}

export async function register(app: Express, ctx: BootContext): Promise<void> {
  app.all("/api/auth/*", toNodeHandler(auth));

  if (ctx.env === "development") {
    await seedDevAdmin();
  }

  // Production first-admin bootstrap (self-gates on ADMIN_EMAIL/ADMIN_PASSWORD,
  // so it is a safe no-op in every other case). Runs after the dev seed.
  await bootstrapFirstAdmin();
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
    await db.user.update({
      where: { id: user.id },
      data: { role: "ADMIN", initials: "AD", emailVerified: true },
    });
    console.log("[seed] development admin created");
  } catch (error) {
    console.warn("[seed] dev admin seed skipped:", (error as Error).message);
  }
}
