/**
 * App-facing entry point for the demo seed: the dashboard's admin-only
 * „Demo-Workspace laden" action calls `loadDemoWorkspace`, which runs the shared
 * `seedWorkspace` (scripts/seed/workspace-seed.ts — also what `prisma/seed.ts`
 * runs) inside `txWithAudit` so every written row carries its audit row.
 *
 * The audit actor is the admin who pressed the button, not SEED_ACTOR — the
 * append-only log records who loaded the demo. Production is never seeded
 * automatically: the only paths in are this action and the `pnpm db:seed`
 * script, both deliberate.
 */
import { txWithAudit } from "~/lib/audit.server";
import type { AuthUser } from "~/lib/auth.server";
import type { SeedSummary } from "../../scripts/seed/workspace-seed";
import { seedWorkspace } from "../../scripts/seed/workspace-seed";

export async function loadDemoWorkspace(actor: AuthUser): Promise<SeedSummary> {
  // `assignToUserId`: the admin loading the demo also gets a handful of
  // open demo tasks and tickets assigned, so their „Meine Arbeit" card is
  // populated from the first render. The CLI seed passes no actor and skips it.
  return txWithAudit(actor, (tx, audit) => seedWorkspace(tx, audit, { assignToUserId: actor.id }), {
    timeout: 120_000,
    maxWait: 15_000,
  });
}
