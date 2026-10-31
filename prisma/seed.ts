/**
 * The demo workspace seed's CLI entry point.
 *
 *   pnpm db:seed                # via `prisma db seed` (prisma.config.ts migrations.seed)
 *   tsx prisma/seed.ts          # directly
 *
 * The seed itself lives in `scripts/seed/workspace-seed.ts` so the
 * dashboard's admin-only „Demo-Workspace laden" action
 * (`app/lib/demo-seed.server.ts`) runs the same implementation — one code path,
 * still idempotent by stable ids. This file keeps its exports for
 * `test/seed-integrity.test.ts`, which hands the seed a transaction it rolls
 * back; nothing here runs unless the file is executed directly.
 */
import { pathToFileURL } from "node:url";

import {
  SEED_ACTOR,
  seedWorkspace,
  totalCreated,
  totalSkipped,
} from "../scripts/seed/workspace-seed";

export {
  DEMO_USER,
  EXPECTED_COUNTS,
  EXPECTED_DEMO_USER_COUNT,
  EXPECTED_LOCATION_KIND_COUNT,
  SEED_ID_PREFIX,
  type CountKey,
} from "../scripts/seed/data";
export {
  EXPECTED_SEEDED_ROW_COUNT,
  SEED_ACTOR,
  UNTOUCHED_TABLES,
  seedWorkspace,
  totalCreated,
  totalSkipped,
  type SeedSummary,
} from "../scripts/seed/workspace-seed";

// ── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // MUST precede any module that constructs the Prisma client — ESM imports are
  // hoisted, so the DB modules below are imported dynamically after this point.
  // `prisma db seed` already provides
  // DATABASE_URL through the CLI's own environment (measured); this is
  // for a direct `tsx prisma/seed.ts`.
  try {
    process.loadEnvFile();
  } catch {
    // No .env — the environment must provide DATABASE_URL.
  }

  const { db } = await import("~/lib/db.server");
  const { txWithAudit } = await import("~/lib/audit.server");
  try {
    // One transaction for the whole seed: the data and its audit rows commit
    // together or not at all. Generous timeouts because this is a bulk writer
    // doing hundreds of sequential round-trips (same reason as run.ts).
    const summary = await txWithAudit(SEED_ACTOR, (tx, audit) => seedWorkspace(tx, audit), {
      timeout: 120_000,
      maxWait: 15_000,
    });
    console.log(
      `[seed] created ${totalCreated(summary)} rows, left ${totalSkipped(summary)} untouched`,
    );
    console.log(`[seed] ${JSON.stringify(summary.created)}`);
    if (totalSkipped(summary) > 0) {
      console.log(
        `[seed] already present: ${JSON.stringify(summary.skipped)} (a re-run writes nothing)`,
      );
    }
    console.log(`[seed] audit rows written: ${summary.auditRows}`);
  } finally {
    await db.$disconnect();
  }
}

// Only when executed directly. The test imports this module and calls
// `seedWorkspace` with its own client, so it must never reach `main()`.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
