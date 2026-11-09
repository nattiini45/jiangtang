import type { Tx } from "~/lib/db.server";
import type { AuditActor, AuditFn } from "~/lib/audit.server";
import { tr } from "~/i18n/request-locale.server";
import { ValidationError } from "~/lib/errors.server";
import { laneTailPosition } from "./tasks.mutations.server";
import { laneOfTaskStatus } from "./tasks.lanes";
import { TASK_RESTORE_AUDIT } from "./tasks.transitions";
import { addTaskBlockerInTx } from "./tasks.dependencies.server";
import type { TransferTask } from "~/domains/transfer/transfer.schema";

/**
 * In-transaction task upserts for the workspace import — the owning domain
 * writes its own model, in the caller's transaction. Two passes like the
 * project import: rows first (assignees resolved and replaced wholesale on
 * update), then `parentTaskId` links, then `blockedBy` edges via the same
 * advisory-locked cycle check `addTaskBlocker` uses — a cycle in the file
 * refuses the whole import.
 *
 * `projectBySlug` and `userByEmail` arrive pre-loaded by the orchestrator —
 * resolving them per row would be one query per reference.
 */
export async function importTasksInTx(
  tx: Tx,
  audit: AuditFn,
  actor: AuditActor,
  rows: TransferTask[],
  projectBySlug: Map<string, string>,
  userByEmail: Map<string, string>,
): Promise<void> {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  interface Resolved {
    projectId: string | null;
    assignees: { userId: string; estimateMinutes: number | null }[];
  }
  const resolved = new Map<string, Resolved>();

  for (const [i, t] of rows.entries()) {
    const n = tr("work.err.import.taskLabel", { index: i + 1, title: t.title });
    if (seenIds.has(t.id)) errors.push(`${n}: ${tr("work.err.import.duplicateId")}`);
    seenIds.add(t.id);

    let projectId: string | null = null;
    if (t.projectSlug) {
      projectId = projectBySlug.get(t.projectSlug) ?? null;
      if (!projectId) {
        errors.push(`${n}: ${tr("work.err.import.projectSlugUnknown", { slug: t.projectSlug })}`);
      }
    }
    const assignees: Resolved["assignees"] = [];
    for (const a of t.assignees) {
      const userId = userByEmail.get(a.email.toLowerCase());
      if (!userId) {
        errors.push(`${n}: ${tr("work.err.import.assigneeUnknown", { email: a.email })}`);
      } else {
        assignees.push({ userId, estimateMinutes: a.estimateMinutes });
      }
    }
    resolved.set(t.id, { projectId, assignees });
  }
  if (errors.length > 0) throw new ValidationError({}, errors);

  for (const t of rows) {
    const r = resolved.get(t.id)!;
    const data = {
      title: t.title,
      body: t.body,
      status: t.status,
      priority: t.priority,
      startAt: t.startAt,
      dueAt: t.dueAt,
      estimateMinutes: t.estimateMinutes,
      labels: t.labels,
      projectId: r.projectId,
    };
    const before = await tx.task.findUnique({ where: { id: t.id }, select: { id: true } });
    if (before) {
      await tx.task.update({ where: { id: t.id }, data });
      // The file carries the complete assignee set — replace, don't merge.
      await tx.taskAssignees.deleteMany({ where: { taskId: t.id } });
      if (r.assignees.length) {
        await tx.taskAssignees.createMany({
          data: r.assignees.map((a) => ({ taskId: t.id, ...a })),
        });
      }
    } else {
      const position = await laneTailPosition(tx, laneOfTaskStatus(t.status));
      await tx.task.create({
        data: {
          ...data,
          id: t.id,
          position,
          createdById: actor.id,
          assignees: r.assignees.length ? { create: r.assignees } : undefined,
        },
      });
    }
    await audit({
      action: before ? TASK_RESTORE_AUDIT.update : TASK_RESTORE_AUDIT.create,
      entityType: "task",
      entityId: t.id,
      data: { title: t.title, status: t.status, viaImport: true },
    });
  }

  // parentTaskId links — second pass so a parent imported in the same file
  // resolves regardless of row order.
  const linkErrors: string[] = [];
  for (const [i, t] of rows.entries()) {
    if (!t.parentTaskId) continue;
    if (t.parentTaskId === t.id) {
      linkErrors.push(
        `${tr("work.err.import.taskLabel", { index: i + 1, title: t.title })}: ${tr("work.err.import.selfParentTask")}`,
      );
      continue;
    }
    const parent = await tx.task.findUnique({
      where: { id: t.parentTaskId },
      select: { id: true },
    });
    if (!parent) {
      linkErrors.push(
        `${tr("work.err.import.taskLabel", { index: i + 1, title: t.title })}: ${tr("work.err.import.parentTaskIdUnknown", { id: t.parentTaskId })}`,
      );
      continue;
    }
    await tx.task.update({ where: { id: t.id }, data: { parentTaskId: t.parentTaskId } });
  }
  if (linkErrors.length > 0) throw new ValidationError({}, linkErrors);
}

/**
 * The `blockedBy` edges — last step of the import so both endpoints exist.
 * Existing edges are skipped (a re-import is idempotent); a cycle or an
 * unknown endpoint refuses the file via `addTaskBlockerInTx`'s own checks.
 */
export async function importTaskEdgesInTx(
  tx: Tx,
  audit: AuditFn,
  rows: TransferTask[],
): Promise<number> {
  const wanted = rows.flatMap((t) => t.blockedBy.map((b) => [t.id, b] as const));
  if (wanted.length === 0) return 0;

  const ids = [...new Set(wanted.flat())];
  const known = new Set(
    (await tx.task.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((t) => t.id),
  );
  const missing: string[] = [];
  for (const [taskId, blockerId] of wanted) {
    if (!known.has(taskId)) missing.push(tr("work.err.import.taskIdUnknown", { id: taskId }));
    if (!known.has(blockerId)) {
      missing.push(tr("work.err.import.blockerUnknown", { blockerId, taskId }));
    }
  }
  if (missing.length > 0) throw new ValidationError({}, missing);

  let created = 0;
  for (const [taskId, blockerId] of wanted) {
    const edge = await addTaskBlockerInTx(tx, audit, taskId, blockerId, { skipIfExists: true });
    if (edge) created += 1;
  }
  return created;
}
