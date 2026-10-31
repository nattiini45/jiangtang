import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "~/generated/prisma/client";

// Prisma's interactive transactions abort after ~5 s. A full Vitest run keeps one
// Postgres busy enough that a few multi-step domain transactions (task/ticket harmony,
// equipment cloning) occasionally cross that line without anything being wrong.
// Pre-seeding the process-wide client singleton from `app/lib/db.server.ts` gives the
// tests a roomier window; production keeps Prisma's defaults. The adapter options
// mirror `createClient` there (UTC session) — keep them in step.
const globalForDb = globalThis as unknown as { __jiangtangDb?: PrismaClient };

if (!globalForDb.__jiangtangDb) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("setup-tx-timeout must run after setup-env (DATABASE_URL is not set).");
  }
  globalForDb.__jiangtangDb = new PrismaClient({
    adapter: new PrismaPg({ connectionString, options: "-c TimeZone=UTC" }),
    transactionOptions: { maxWait: 30_000, timeout: 60_000 },
  });
}
