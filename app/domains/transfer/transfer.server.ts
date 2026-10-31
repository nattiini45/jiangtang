import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { ValidationError } from "~/lib/errors.server";
import { db } from "~/lib/db.server";
import { localizeMessage } from "~/i18n";
import { currentLocale, tr } from "~/i18n/request-locale.server";
import { workspaceTransferSchema } from "./transfer.schema";
import { importProjectsInTx } from "~/domains/projects/projects.transfer.server";
import { importTasksInTx, importTaskEdgesInTx } from "~/domains/tasks/tasks.transfer.server";
import { importNotesInTx } from "~/domains/notes/notes.transfer.server";

/**
 * Workspace import orchestrator. This domain writes NOTHING of its own —
 * `FOLDERS["app/domains/transfer"]` is `[]`. The domain-ownership rule: the
 * per-model upserts live in the owning domains (`projects.transfer.server.ts`
 * etc.) and are called here, inside ONE `txWithAudit`, in dependency order:
 * projects → tasks (+ parents) → dependency edges → notes. Any refusal —
 * unknown reference, duplicate id, slug owned by a different row, a blocker
 * cycle — throws inside the transaction and the whole file rolls back.
 */
export interface ImportSummary {
  projects: number;
  tasks: number;
  notes: number;
  edges: number;
}

export async function importWorkspace(actor: AuditActor, raw: unknown): Promise<ImportSummary> {
  const parsed = workspaceTransferSchema.safeParse(raw);
  if (!parsed.success) {
    const locale = currentLocale();
    throw new ValidationError({}, [
      tr("places.err.transfer.invalidFile"),
      ...parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join(".") || "(root)"}: ${localizeMessage(locale, i.message)}`),
    ]);
  }
  const data = parsed.data;

  // Reference maps load BEFORE the transaction — same discipline as the CSV
  // import: a slug/email written between load and commit is just unknown.
  const users = await db.user.findMany({ select: { id: true, email: true } });
  const userByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  return txWithAudit(
    actor,
    async (tx, audit) => {
      await importProjectsInTx(tx, audit, actor, data.projects);

      // Project slugs resolve AFTER the project pass — a task's projectSlug may
      // point at a project this same file just created.
      const projects = await tx.project.findMany({ select: { id: true, slug: true } });
      const projectBySlug = new Map(projects.map((p) => [p.slug, p.id]));

      await importTasksInTx(tx, audit, actor, data.tasks, projectBySlug, userByEmail);
      const edges = await importTaskEdgesInTx(tx, audit, data.tasks);
      await importNotesInTx(tx, audit, actor, data.notes, projectBySlug);

      return {
        projects: data.projects.length,
        tasks: data.tasks.length,
        notes: data.notes.length,
        edges,
      };
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
