import { tr } from "~/i18n/request-locale.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { type Tx } from "~/lib/db.server";
import { Prisma } from "~/generated/prisma/client";
import type { TaskDependency } from "~/generated/prisma/client";

/**
 * Task-dependency mutations. Edge semantics: a `TaskDependency`
 * row `(blockedByTaskId = A, blockingTaskId = B)` means **A is blocked by B**
 * — B must finish first. `addTaskBlocker(A, B)` therefore writes exactly that
 * row.
 *
 * **The graph must stay a DAG.** The refusals, in the order they fire:
 * self-edge, missing endpoint, duplicate, and any edge that closes a cycle —
 * adding "A blocked by B" closes a cycle iff A is reachable from B by walking
 * B's blockers (a recursive CTE over `blockingTaskId`).
 *
 * **Serialisation:** dependency writes take a transaction-scoped advisory lock
 * (`pg_advisory_xact_lock`, the events-sequence precedent) so two concurrent
 * `addTaskBlocker` calls cannot each pass the reachability check against the
 * other's still-uncommitted edge and create the cycle both refused. The lock
 * releases on commit/rollback. Removals cannot create a cycle and take no
 * lock.
 *
 * A refused mutation writes nothing — no edge, no audit row.
 */

/** One global lock key — dependency writes serialize across ALL task pairs,
 *  because a cycle can span tasks neither transaction touched directly. */
const DEPENDENCY_LOCK_KEY = "task-dependency";

/** Both endpoints must exist — a dangling edge is a ValidationError, not a P2003. */
async function requireTaskTitles(tx: Tx, ids: string[]) {
  const tasks = await tx.task.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true },
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const id of ids) {
    if (!byId.has(id)) throw new NotFoundError(tr("work.err.task.notFound"));
  }
  return byId;
}

/**
 * Is `target` reachable from `start` by walking blockers — i.e., is `start`
 * transitively blocked by `target` already? Recursive CTE over
 * `blockedByTaskId → blockingTaskId`, bounded by `hops` so a hierarchy that
 * already loops terminates instead of hanging the transaction.
 */
async function isReachableViaBlockers(
  tx: Tx,
  start: string,
  target: string,
  maxHops = 200,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ found: boolean }>>(Prisma.sql`
    WITH RECURSIVE reach AS (
      SELECT "blockingTaskId" AS id, 1::int AS hops
      FROM "TaskDependency"
      WHERE "blockedByTaskId" = ${start}
      UNION
      SELECT d."blockingTaskId", r.hops + 1
      FROM "TaskDependency" d
      JOIN reach r ON d."blockedByTaskId" = r.id
      WHERE r.hops < ${maxHops}
    )
    SELECT EXISTS (SELECT 1 FROM reach WHERE id = ${target}) AS found
  `);
  return rows[0]?.found === true;
}

/**
 * `addTaskBlocker(actor, taskId, blockerTaskId)` — "taskId is blocked by
 * blockerTaskId". Audited `TaskBlockerAdded` on the BLOCKED task
 * (`entityId = taskId`) — the card whose plan changed.
 */
export async function addTaskBlocker(
  actor: AuditActor,
  taskId: string,
  blockerTaskId: string,
): Promise<TaskDependency> {
  if (taskId === blockerTaskId) {
    // Outside the transaction: a self-edge can never reach the DB, and the
    // refusal must not even take the lock.
    throw new ValidationError({
      blockerTaskId: [tr("work.err.task.selfBlocker")],
    });
  }
  return txWithAudit(actor, async (tx, audit) => {
    const edge = await addTaskBlockerInTx(tx, audit, taskId, blockerTaskId, {
      skipIfExists: false,
    });
    // Without skipIfExists the helper never resolves null — the type only
    // widened for the idempotent re-import path.
    return edge!;
  });
}

/**
 * The in-transaction edge write: same advisory lock, existence check and
 * reachability/cycle refusal as `addTaskBlocker`, callable inside a bigger
 * `txWithAudit` — the workspace import creates all task edges in one file's
 * transaction, so a mid-file cycle rolls the whole import back.
 * `skipIfExists` turns "edge already exists" into a silent no-op — a repeated
 * import of the same file is idempotent rather than a row error.
 */
export async function addTaskBlockerInTx(
  tx: Tx,
  audit: AuditFn,
  taskId: string,
  blockerTaskId: string,
  opts: { skipIfExists?: boolean } = {},
): Promise<TaskDependency | null> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${DEPENDENCY_LOCK_KEY}, 0))`;

  const tasks = await requireTaskTitles(tx, [taskId, blockerTaskId]);
  const existing = await tx.taskDependency.findUnique({
    where: {
      blockedByTaskId_blockingTaskId: { blockedByTaskId: taskId, blockingTaskId: blockerTaskId },
    },
  });
  if (existing) {
    // `null` on skip — the caller distinguishes "edge already there" from
    // "edge created" for its import summary; without the flag this is a refusal.
    if (opts.skipIfExists) return null;
    throw new ValidationError({
      blockerTaskId: [tr("work.err.task.blockerExists")],
    });
  }
  // Cycle iff the BLOCKED task (taskId) is reachable from the new blocker —
  // i.e. blockerTaskId is already transitively blocked by taskId.
  if (await isReachableViaBlockers(tx, blockerTaskId, taskId)) {
    throw new ValidationError({}, [
      tr("work.err.task.cycle", {
        taskTitle: tasks.get(taskId)!.title,
        blockerTitle: tasks.get(blockerTaskId)!.title,
      }),
    ]);
  }

  const edge = await tx.taskDependency.create({
    data: { blockedByTaskId: taskId, blockingTaskId: blockerTaskId },
  });
  await audit({
    action: "TaskBlockerAdded",
    entityType: "task",
    entityId: taskId,
    data: { blockingTaskId: blockerTaskId, blockingTitle: tasks.get(blockerTaskId)!.title },
  });
  return edge;
}

/**
 * `removeTaskBlocker(actor, taskId, blockerTaskId)` — drops the "taskId is
 * blocked by blockerTaskId" edge. Refused when the edge does not exist.
 * Audited `TaskBlockerRemoved` on the blocked task.
 */
export async function removeTaskBlocker(
  actor: AuditActor,
  taskId: string,
  blockerTaskId: string,
): Promise<void> {
  return txWithAudit(actor, async (tx, audit) => {
    const tasks = await requireTaskTitles(tx, [taskId, blockerTaskId]);
    const existing = await tx.taskDependency.findUnique({
      where: {
        blockedByTaskId_blockingTaskId: { blockedByTaskId: taskId, blockingTaskId: blockerTaskId },
      },
    });
    if (!existing) {
      throw new ValidationError({ blockerTaskId: [tr("work.err.task.blockerMissing")] });
    }
    await tx.taskDependency.delete({
      where: {
        blockedByTaskId_blockingTaskId: { blockedByTaskId: taskId, blockingTaskId: blockerTaskId },
      },
    });
    await audit({
      action: "TaskBlockerRemoved",
      entityType: "task",
      entityId: taskId,
      data: { blockingTaskId: blockerTaskId, blockingTitle: tasks.get(blockerTaskId)!.title },
    });
  });
}
