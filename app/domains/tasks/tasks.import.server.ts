import { tr } from "~/i18n/request-locale.server";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { ValidationError } from "~/lib/errors.server";
import { db } from "~/lib/db.server";
import type { Task } from "~/generated/prisma/client";
import type { TaskCsvRow } from "./tasks.schema";
import { createTaskInTx } from "./tasks.mutations.server";

/**
 * Bulk task import — the `bulkCreateStock` contract one domain over:
 * whole-file atomicity inside ONE `txWithAudit`, and every refusal is prefixed
 * with the 1-based CSV line (header included) so a rejection in a 30-row file
 * is findable.
 *
 * The row schema (`taskCsvRowSchema`) resolves everything it can without the
 * database — enums and their German labels, day spellings, estimate
 * spellings. What it cannot resolve are the two REFERENCE columns, and they
 * are resolved here, inside the transaction, against two lookup maps loaded
 * once for the file:
 *
 * - `assignees` — comma-separated INITIALS or EMAILS, case-insensitive. An
 *   unknown one is a row error (an import that silently drops an assignment
 *   silently loses work).
 * - `project` — the project SLUG. An unknown slug is a row error, same reason.
 *
 * Tasks land at the END of their status's lane — `createTaskInTx` computes the
 * tail position per row, so rows in one file line up after each other in CSV
 * order.
 */

/** One CSV line, already validated by `previewCsv` + `taskCsvRowSchema`. */
export interface TaskImportRow {
  /** 1-based CSV line, header included — so the number a user sees is this number. */
  line: number;
  data: TaskCsvRow;
}

export async function bulkCreateTasks(
  actor: AuditActor,
  rows: TaskImportRow[],
): Promise<{ created: number; tasks: Task[] }> {
  // Reference maps are loaded BEFORE the transaction: they are read-only
  // lookups, and a 30-row file resolving its own maps per row would be 60
  // queries nobody asked for. A project created mid-import is just unknown to
  // this file — the refusal names the row and the operator re-runs it.
  const [users, projects] = await Promise.all([
    db.user.findMany({ select: { id: true, initials: true, email: true } }),
    db.project.findMany({ select: { id: true, slug: true } }),
  ]);
  const userByKey = new Map<string, string>();
  for (const u of users) {
    if (u.initials) userByKey.set(u.initials.toLowerCase(), u.id);
    userByKey.set(u.email.toLowerCase(), u.id);
  }
  const projectBySlug = new Map(projects.map((p) => [p.slug, p.id]));

  return txWithAudit(
    actor,
    async (tx, audit) => {
      const tasks: Task[] = [];
      for (const row of rows) {
        const rowErrors: string[] = [];
        const assignees = row.data.assignees.map((key) => {
          const userId = userByKey.get(key.toLowerCase());
          if (!userId) rowErrors.push(tr("work.err.csv.assigneeUnknown", { key }));
          return { userId: userId ?? key };
        });
        const projectId = row.data.project ? projectBySlug.get(row.data.project) : undefined;
        if (row.data.project && !projectId) {
          rowErrors.push(tr("work.err.csv.projectUnknown", { slug: row.data.project }));
        }
        if (rowErrors.length > 0) {
          throw new ValidationError({}, [
            tr("work.err.import.row", { line: row.line, errors: rowErrors.join("; ") }),
          ]);
        }
        const task = await createTaskInTx(
          tx,
          audit,
          actor,
          {
            title: row.data.title,
            status: row.data.status ?? "BACKLOG",
            priority: row.data.priority,
            startAt: row.data.start ?? null,
            dueAt: row.data.due ?? null,
            estimateMinutes: row.data.estimate,
            projectId,
            labels: row.data.labels,
          },
          assignees,
          { viaImport: true },
        );
        tasks.push(task);
      }
      return { created: tasks.length, tasks };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
