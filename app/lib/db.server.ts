import { PrismaClient } from "~/generated/prisma/client";
import type { Prisma } from "~/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * The single Prisma client for the process.
 *
 * Prisma 7 is Rust-free: the connection runs through the `@prisma/adapter-pg`
 * driver adapter (one `pg` Pool). App code imports `db` from here and model /
 * enum types from `~/generated/prisma/client` — never `@prisma/client`.
 */

const globalForDb = globalThis as unknown as { __jiangtangDb?: PrismaClient };

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set (check .env or the environment).");
  }
  // UTC sessions: adapter-pg serialises DateTime params as offset-less
  // UTC wall-clock strings and rewrites timestamptz text to "+00:00" on reads.
  // Both are correct only when the session TimeZone is UTC — under the server's
  // Europe/Berlin default every written instant landed one zone-offset early.
  const adapter = new PrismaPg({ connectionString, options: "-c TimeZone=UTC" });
  return new PrismaClient({ adapter });
}

// HMR-safe singleton: Vite re-evaluates server modules on change in dev, so we
// cache the client on globalThis to avoid leaking connection pools across reloads.
export const db: PrismaClient = globalForDb.__jiangtangDb ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__jiangtangDb = db;
}

/** A transaction-scoped client, as handed to `db.$transaction(async (tx) => …)`. */
export type Tx = Prisma.TransactionClient;
