import { defineConfig } from "prisma/config";

// Prisma 7 no longer auto-loads .env. Load it for local CLI use (migrate/studio);
// in CI/prod the DATABASE_URL is provided by the real environment.
try {
  process.loadEnvFile();
} catch {
  // No .env file present — DATABASE_URL is expected to be set in the environment.
}

/**
 * Shadow database for `prisma migrate dev` and `migrate diff --from-migrations`.
 *
 * Why this exists: with no shadow URL, `migrate dev`
 * MANUFACTURES a shadow by resetting the dev database, and `migrate diff
 * --from-migrations` cannot be run at all. Both are how a generated migration
 * ends up on the dev database before anyone read it.
 *
 * Why it must never equal DATABASE_URL: that equality IS the reset. The two are
 * two different databases on the same server, so the host/credentials are
 * deliberately carried over and only the database name is swapped.
 *
 * `migrate deploy` — the CI and production path — never touches a shadow
 * database, so declaring one here cannot affect either.
 */
export function deriveShadowUrl(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return undefined;
  try {
    const url = new URL(databaseUrl);
    url.pathname = "/jiangtang_shadow";
    return url.toString();
  } catch {
    // Not a parseable URL: let the Prisma CLI report the real problem rather
    // than throwing a second, more confusing one from here.
    return undefined;
  }
}

const databaseUrl = process.env.DATABASE_URL;
const shadowDatabaseUrl = process.env.SHADOW_DATABASE_URL ?? deriveShadowUrl(databaseUrl);

if (shadowDatabaseUrl && shadowDatabaseUrl === databaseUrl) {
  throw new Error(
    "prisma.config.ts: SHADOW_DATABASE_URL must not equal DATABASE_URL — that would reset the development database.",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: databaseUrl,
    shadowDatabaseUrl,
  },
  // Prisma 7 moved the seed hook out of package.json. Confirmed in two
  // independent places: the installed CLI reads
  // `migrations?.seed`, and `@prisma/config` ships
  // `MigrationsConfigShape.seed?: string`.
  //
  // Why this key is load-bearing rather than cosmetic: with it absent, `prisma
  // db seed` prints "No seed command configured" and EXITS 0. A build tick
  // would have recorded "seed green" against a database that received nothing —
  // and a hook that THROWS makes the command exit 1. So
  // this one line is what turns `pnpm db:seed`'s exit code into an instrument
  // that can fail.
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
