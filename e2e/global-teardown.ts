import type { AuditActor } from "~/lib/audit.server";
import { runPrefix } from "./run";

/**
 * Sweep `e2e-<runId>-`-prefixed tasks/notes/projects through the domain delete
 * functions (same-transaction audit included; the ActivityLog rows stay —
 * append-only). Uses the exact run prefix from .run-id, not a broad `e2e-`
 * sweep, so only this run's records are deleted.
 *
 * Resolve and validate the prefix BEFORE database imports/queries.
 * Throw if the prefix is missing or malformed.
 *
 * This file does not call `process.loadEnvFile()`. The test environment must
 * be explicitly constructed rather than inherited from whatever `.env` happens
 * to exist; an ambient file read must never make private file state visible
 * here. This teardown runs in Playwright's main
 * process, where `playwright.config.ts` has already validated
 * `DATABASE_URL_E2E` (required `_e2e` suffix, the routing restrictions) at
 * CONFIG EVALUATION time and assigned it to `process.env.DATABASE_URL` before
 * any E2E import. `~/lib/db.server` below therefore reads that validated
 * target, and `ADMIN_EMAIL` comes from the run's constructed environment.
 *
 * containment and silence are different properties. A single failed
 * delete must not abort the sweep — the remaining rows and the remaining two
 * collections still have to be cleaned up — but the run must NOT stay green
 * when cleanup did not fully happen. Each failure is therefore recorded and,
 * after all three sweeps and after `db.$disconnect()` has completed, a summary
 * error is thrown so Playwright reports a failed global teardown
 * (playwright@1.63.0 `runner/index.js`: a teardown-task throw sets
 * `_hasErrors`, `runTasks` returns `teardownStatus`, and `cli/testActions.js`
 * maps any non-`passed` status to exit code 1). Stale `e2e-<runId>-` rows can
 * then no longer accumulate behind a green gate.
 */
export default async function globalTeardown() {
  // Resolve and validate the run prefix BEFORE any database imports
  const prefix = runPrefix();

  const { db } = await import("~/lib/db.server");
  const { deleteTask } = await import("~/domains/tasks/tasks.mutations.server");
  const { deleteNote } = await import("~/domains/notes/notes.mutations.server");
  const { deleteProject } = await import("~/domains/projects/projects.mutations.server");

  const admin = await db.user.findFirst({
    where: { email: process.env.ADMIN_EMAIL },
  });
  const actor: AuditActor = admin
    ? {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        initials: admin.initials,
      }
    : { name: "e2e teardown" };

  // Failures are collected, not swallowed. Only the label and the row id
  // are kept — never row contents — and the per-row detail (including the
  // underlying error message) is still emitted through `console.warn` as it
  // happens. The verdict below must not depend on that warn being seen.
  const failures: { label: string; id: string }[] = [];

  const sweep = async (
    rows: { id: string }[],
    label: string,
    del: (actor: AuditActor, id: string) => Promise<unknown>,
  ) => {
    for (const row of rows) {
      try {
        await del(actor, row.id);
      } catch (e) {
        // Contained so the remaining rows in this collection and the remaining
        // collections are still swept; recorded so the run cannot stay green.
        failures.push({ label, id: row.id });
        console.warn(`[e2e teardown] ${label} ${row.id}: ${(e as Error).message}`);
      }
    }
  };

  try {
    await sweep(
      await db.task.findMany({
        where: { title: { startsWith: prefix } },
        select: { id: true },
      }),
      "task",
      deleteTask,
    );
    await sweep(
      await db.note.findMany({
        where: { title: { startsWith: prefix } },
        select: { id: true },
      }),
      "note",
      deleteNote,
    );
    await sweep(
      await db.project.findMany({
        where: { name: { startsWith: prefix } },
        select: { id: true },
      }),
      "project",
      deleteProject,
    );
  } finally {
    await db.$disconnect();
  }

  // Thrown AFTER the try/finally, so the disconnect above has already
  // completed. This is what turns failed cleanup into a failed teardown.
  if (failures.length > 0) {
    const perLabel = new Map<string, number>();
    for (const f of failures) {
      perLabel.set(f.label, (perLabel.get(f.label) ?? 0) + 1);
    }
    const counts = [...perLabel.entries()].map(([label, n]) => `${label}=${n}`).join(", ");
    const ids = failures.map((f) => `${f.label}:${f.id}`).join(", ");
    throw new Error(
      `[e2e teardown] cleanup incomplete for run prefix ${prefix}: ` +
        `${failures.length} delete(s) failed (${counts}); undeleted ids: ${ids}. ` +
        `Stale rows remain in the E2E database; per-row causes were logged above.`,
    );
  }
}
