import { tr } from "~/i18n/request-locale.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { db, type Tx } from "~/lib/db.server";
import { Prisma } from "~/generated/prisma/client";
import type { Task, TaskStatus } from "~/generated/prisma/client";
import {
  LANE_TASK_STATUSES,
  laneOfTaskStatus,
  TASK_LANE_DEFAULT_STATUS,
  type Lane,
} from "./tasks.lanes";
import { positionBetween } from "./tasks.position";
import { CUID_PATTERN } from "~/domains/transfer/transfer.schema";
import type {
  TaskAssigneeInput,
  TaskCreateInput,
  TaskEditInput,
  TaskMoveInput,
} from "./tasks.schema";

/**
 * Tasks-domain mutations. Every one of them runs through `txWithAudit`,
 * so the `ActivityLog` row commits with the change or not at all — entityType
 * `"task"` throughout.
 *
 * **A refused mutation writes nothing** — not the change, and not an audit row
 * delete-with-subtasks, parent-cycles, a status the task already
 * has, a move whose neighbours are not in the target lane, unknown ids.
 */

/** A task id that is not a real row. Checked before anything is written. */
async function requireTaskRow(tx: Tx, id: string, field = "parentTaskId"): Promise<Task> {
  const task = await tx.task.findUnique({ where: { id } });
  if (!task) throw new ValidationError({ [field]: [tr("work.err.task.unknown")] });
  return task;
}

/**
 * Is `candidateId` somewhere STRICTLY below `ancestorId` in the task tree? The
 * `isProjectDescendantWithin` walk pointed at `Task.parentTaskId`, on the
 * caller's transaction so it sees the same snapshot.
 */
async function isTaskDescendantWithin(
  tx: Tx,
  ancestorId: string,
  candidateId: string,
  maxHops = 100,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ found: boolean }>>(Prisma.sql`
    WITH RECURSIVE up AS (
      SELECT id, "parentTaskId", 0::int AS hops
      FROM "Task"
      WHERE id = ${candidateId}
      UNION ALL
      SELECT parent.id, parent."parentTaskId", child.hops + 1
      FROM "Task" parent
      JOIN up child ON child."parentTaskId" = parent.id
      WHERE child.hops < ${maxHops}
    )
    SELECT EXISTS (SELECT 1 FROM up WHERE id = ${ancestorId} AND hops > 0) AS found
  `);
  return rows[0]?.found === true;
}

/** The position a NEW card takes in `lane` — one past the current tail. */
export async function laneTailPosition(tx: Tx, lane: Lane): Promise<Prisma.Decimal> {
  const last = await tx.task.findFirst({
    where: { status: { in: LANE_TASK_STATUSES[lane] } },
    orderBy: [{ position: "desc" }, { id: "desc" }],
    select: { position: true },
  });
  return positionBetween(last?.position ?? null, null)!;
}

/**
 * A lane that has run out of fractional room is renumbered 1..n in its current
 * order — the recovery `positionBetween` returning `null` asks for. Rare by
 * construction (Decimal(20,10) has deep headroom) but not impossible, and it
 * must happen inside the caller's transaction so a crash mid-renumber rolls
 * the whole move back.
 */
async function rebalanceLane(tx: Tx, lane: Lane): Promise<void> {
  const tasks = await tx.task.findMany({
    where: { status: { in: LANE_TASK_STATUSES[lane] } },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  for (const [i, task] of tasks.entries()) {
    await tx.task.update({ where: { id: task.id }, data: { position: new Prisma.Decimal(i + 1) } });
  }
}

/** Validate the optional FK references a create/edit carries. */
async function checkTaskRefs(
  tx: Tx,
  input: { projectId?: string; parentTaskId?: string; locationId?: string },
): Promise<void> {
  if (input.projectId) {
    const p = await tx.project.findUnique({ where: { id: input.projectId }, select: { id: true } });
    if (!p) throw new ValidationError({ projectId: [tr("work.err.project.unknown")] });
  }
  if (input.parentTaskId) await requireTaskRow(tx, input.parentTaskId);
  if (input.locationId) {
    const l = await tx.location.findUnique({
      where: { id: input.locationId },
      select: { id: true },
    });
    if (!l) throw new ValidationError({ locationId: [tr("work.err.task.locationUnknown")] });
  }
}

/**
 * The in-transaction create — the `createTicketInTx`/`createEquipmentInTx`
 * precedent: callers that must compose a task create with other writes (the
 * CSV import's all-or-nothing file) get the same checks, the same lane-tail
 * position, and the same `TaskCreated` audit row inside THEIR transaction.
 * `extraData` merges into the audit row's data (the import's `viaImport`).
 */
export async function createTaskInTx(
  tx: Tx,
  audit: AuditFn,
  actor: AuditActor | null,
  input: TaskCreateInput,
  assignees: TaskAssigneeInput[] = [],
  extraData: Record<string, unknown> = {},
  clientId?: string,
): Promise<Task> {
  await checkTaskRefs(tx, input);
  await checkAssigneeUsers(
    tx,
    assignees.map((a) => a.userId),
  );
  const position = await laneTailPosition(tx, laneOfTaskStatus(input.status));
  const task = await tx.task.create({
    data: {
      ...(clientId ? { id: clientId } : {}),
      title: input.title,
      body: input.body ?? null,
      status: input.status,
      priority: input.priority ?? null,
      startAt: input.startAt ?? null,
      dueAt: input.dueAt ?? null,
      estimateMinutes: input.estimateMinutes ?? null,
      projectId: input.projectId ?? null,
      parentTaskId: input.parentTaskId ?? null,
      locationId: input.locationId ?? null,
      labels: input.labels,
      position,
      createdById: actor?.id ?? null,
      assignees: assignees.length
        ? {
            create: assignees.map((a) => ({
              userId: a.userId,
              estimateMinutes: a.estimateMinutes ?? null,
            })),
          }
        : undefined,
    },
  });
  await audit({
    action: "TaskCreated",
    entityType: "task",
    entityId: task.id,
    data: { title: task.title, status: task.status, position: position.toString(), ...extraData },
  });
  return task;
}

/**
 * `createTask(actor, input, assignees?)` — the card lands at the END of the
 * lane its status belongs to (position = tail + 1, or 1 in an empty lane).
 */
export async function createTask(
  actor: AuditActor,
  input: TaskCreateInput,
  assignees: TaskAssigneeInput[] = [],
  clientId?: string,
): Promise<Task> {
  try {
    return await txWithAudit(actor, async (tx, audit) => {
      if (clientId !== undefined) {
        assertClientId(clientId);
        // Idempotent capture: an offline-queue replay or a double submit
        // with the same client id returns the row the first submit created —
        // no second row, no second audit entry.
        const existing = await tx.task.findUnique({ where: { id: clientId } });
        if (existing) return existing;
      }
      return createTaskInTx(tx, audit, actor, input, assignees, {}, clientId);
    });
  } catch (error) {
    // Two replays can pass the findUnique above at the same time. The loser's
    // id insert then violates the primary key; by the time that surfaces the
    // winner has committed, so returning its row keeps the capture idempotent
    // instead of turning the duplicate into a 500.
    if (clientId !== undefined && isUniqueViolation(error)) {
      const existing = await db.task.findUnique({ where: { id: clientId } });
      if (existing) return existing;
    }
    throw error;
  }
}

/** P2002 or the driver-adapter's structured unique violation, at any depth. */
function isUniqueViolation(error: unknown): boolean {
  let cur: unknown = error;
  for (let depth = 0; cur && depth < 6; depth++) {
    const e = cur as {
      code?: unknown;
      meta?: { driverAdapterError?: { cause?: { kind?: unknown } } };
    };
    if (e.code === "P2002") return true;
    if (e.meta?.driverAdapterError?.cause?.kind === "UniqueConstraintViolation") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** The cuid shape the offline queue mints — anything else is a refusal. */
function assertClientId(clientId: string): void {
  if (!CUID_PATTERN.test(clientId)) {
    throw new ValidationError({ clientId: [tr("work.err.invalidClientId")] });
  }
}

/**
 * `updateTask` — content fields only (status and position live in
 * `setTaskStatus` / `moveTask`). `parentTaskId` is editable here, with the
 * reparent refusal `updateProject` gives `parentProjectId`: a task cannot be
 * moved under itself or under one of its own subtasks.
 */
export async function updateTask(
  actor: AuditActor,
  id: string,
  input: TaskEditInput,
): Promise<Task> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.task.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("work.err.task.notFound"));

    const parentTaskId = input.parentTaskId ?? null;
    if (parentTaskId) {
      if (parentTaskId === id) {
        throw new ValidationError({
          parentTaskId: [tr("work.err.task.selfParent")],
        });
      }
      const parent = await requireTaskRow(tx, parentTaskId);
      if (await isTaskDescendantWithin(tx, id, parentTaskId)) {
        throw new ValidationError({
          parentTaskId: [
            tr("work.err.task.parentInSubtree", { parentTitle: parent.title, title: before.title }),
          ],
        });
      }
    }
    await checkTaskRefs(tx, { projectId: input.projectId, locationId: input.locationId });

    const task = await tx.task.update({
      where: { id },
      data: {
        title: input.title,
        body: input.body ?? null,
        priority: input.priority ?? null,
        startAt: input.startAt ?? null,
        dueAt: input.dueAt ?? null,
        estimateMinutes: input.estimateMinutes ?? null,
        projectId: input.projectId ?? null,
        parentTaskId,
        locationId: input.locationId ?? null,
        labels: input.labels,
      },
    });
    await audit({
      action: "TaskUpdated",
      entityType: "task",
      entityId: id,
      data: {
        from: {
          title: before.title !== task.title ? before.title : undefined,
          parentTaskId: before.parentTaskId !== task.parentTaskId ? before.parentTaskId : undefined,
          projectId: before.projectId !== task.projectId ? before.projectId : undefined,
        },
        to: { title: task.title, parentTaskId: task.parentTaskId, projectId: task.projectId },
      },
    });
    return task;
  });
}

/**
 * `setTaskStatus` — a lifecycle transition, audited `TaskStatusChanged
 * {from,to}`. The card moves to the END of the new status's lane: a status
 * change is a lane change (the mapping is total), and a card that kept its old
 * position would surface mid-lane in an order nobody chose. Setting the status
 * the task already has is refused — no change, no audit noise.
 */
export async function setTaskStatus(
  actor: AuditActor,
  id: string,
  status: TaskStatus,
): Promise<Task> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.task.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("work.err.task.notFound"));
    if (before.status === status) {
      throw new ValidationError({ status: [tr("work.err.task.statusAlready")] });
    }
    const position = await laneTailPosition(tx, laneOfTaskStatus(status));
    const task = await tx.task.update({ where: { id }, data: { status, position } });
    await audit({
      action: "TaskStatusChanged",
      entityType: "task",
      entityId: id,
      data: { title: task.title, from: before.status, to: status },
    });
    return task;
  });
}

/**
 * `moveTask(actor, id, { lane, beforeId?, afterId? })` — the board drop. `lane`
 * is where the card lands; `afterId`/`beforeId` are the cards it lands between
 * in lane order (absent = top/bottom edge). Status is kept when it already
 * belongs to `lane` (BLOCKED stays BLOCKED in IN_REVIEW); otherwise the card
 * takes `TASK_LANE_DEFAULT_STATUS[lane]`.
 *
 * Position is `positionBetween` on the named neighbours — both validated to be
 * IN `lane`, because a neighbour outside the lane would smuggle a card into an
 * ordering it never earned. When the gap has converged (`null`), the lane is
 * renumbered 1..n in current order and the midpoint retaken — the neighbours'
 * positions are re-read after renumbering.
 *
 * A true no-op — same lane, same current neighbours — writes nothing and
 * audits nothing.
 */
export async function moveTask(actor: AuditActor, id: string, move: TaskMoveInput): Promise<Task> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.task.findUnique({ where: { id } });
    if (!before) throw new NotFoundError(tr("work.err.task.notFound"));

    const lane = move.lane;
    const currentLane = laneOfTaskStatus(before.status);

    // Neighbours must be real tasks in the target lane — validated before any write.
    const prev = move.afterId ? await requireTaskRow(tx, move.afterId, "afterId") : null;
    const next = move.beforeId ? await requireTaskRow(tx, move.beforeId, "beforeId") : null;
    for (const [field, n] of [
      ["afterId", prev],
      ["beforeId", next],
    ] as const) {
      if (n && laneOfTaskStatus(n.status) !== lane) {
        throw new ValidationError({ [field]: [tr("work.err.task.notInLane", { title: n.title })] });
      }
      if (n && n.id === id) {
        throw new ValidationError({
          [field]: [tr("work.err.task.besideItself")],
        });
      }
    }

    // No-op: same lane AND the card already sits between exactly these neighbours.
    if (lane === currentLane) {
      const [prevNow, nextNow] = await Promise.all([
        tx.task.findFirst({
          where: {
            status: { in: LANE_TASK_STATUSES[lane] },
            position: { lt: before.position },
            id: { not: id },
          },
          orderBy: [{ position: "desc" }, { id: "desc" }],
          select: { id: true },
        }),
        tx.task.findFirst({
          where: {
            status: { in: LANE_TASK_STATUSES[lane] },
            position: { gt: before.position },
            id: { not: id },
          },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          select: { id: true },
        }),
      ]);
      if (
        (prevNow?.id ?? null) === (move.afterId ?? null) &&
        (nextNow?.id ?? null) === (move.beforeId ?? null)
      ) {
        return before;
      }
    }

    const status = lane === currentLane ? before.status : TASK_LANE_DEFAULT_STATUS[lane];

    let position = positionBetween(prev?.position ?? null, next?.position ?? null);
    if (position === null) {
      await rebalanceLane(tx, lane);
      const prevPos = prev
        ? (await tx.task.findUnique({ where: { id: prev.id }, select: { position: true } }))!
            .position
        : null;
      const nextPos = next
        ? (await tx.task.findUnique({ where: { id: next.id }, select: { position: true } }))!
            .position
        : null;
      // Stale board: the client can send `afterId`/`beforeId` in the wrong order
      // (the lane changed between render and drop). After the rebalance an
      // inverted pair STILL has no midpoint — assert nothing, refuse instead:
      // a wrong-order write would silently land the card somewhere unasked-for.
      if (prevPos !== null && nextPos !== null && prevPos.gte(nextPos)) {
        throw new ValidationError({}, [tr("work.err.laneChanged")]);
      }
      position = positionBetween(prevPos, nextPos)!;
    }

    const task = await tx.task.update({ where: { id }, data: { status, position } });
    await audit({
      action: "TaskMoved",
      entityType: "task",
      entityId: id,
      data: {
        title: task.title,
        fromStatus: before.status,
        toStatus: status,
        lane,
        position: position.toString(),
      },
    });
    return task;
  });
}

/** Every userId must resolve — a dangling assignee is a ValidationError, not a P2003. */
async function checkAssigneeUsers(tx: Tx, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const found = await tx.user.count({ where: { id: { in: userIds } } });
  if (found !== new Set(userIds).size) {
    throw new ValidationError({ assignees: [tr("work.err.unknownUser")] });
  }
}

/**
 * `setTaskAssignees` — REPLACES the set: absent userIds are removed, new ones
 * added, retained ones get their `estimateMinutes` rewritten (the assignee's
 * share — not a partition of `Task.estimateMinutes`). Audited
 * `TaskAssigneesChanged {added, removed}`; an identical set writes nothing.
 */
export async function setTaskAssignees(
  actor: AuditActor,
  id: string,
  assignees: TaskAssigneeInput[],
): Promise<Task> {
  return txWithAudit(actor, async (tx, audit) => {
    const before = await tx.task.findUnique({
      where: { id },
      include: { assignees: { select: { userId: true, estimateMinutes: true } } },
    });
    if (!before) throw new NotFoundError(tr("work.err.task.notFound"));
    await checkAssigneeUsers(
      tx,
      assignees.map((a) => a.userId),
    );

    const next = new Map(assignees.map((a) => [a.userId, a.estimateMinutes ?? null]));
    const current = new Map(before.assignees.map((a) => [a.userId, a.estimateMinutes]));
    const added = [...next.keys()].filter((u) => !current.has(u));
    const removed = [...current.keys()].filter((u) => !next.has(u));
    const reestimated = [...next.keys()].filter(
      (u) => current.has(u) && current.get(u) !== next.get(u),
    );

    if (added.length === 0 && removed.length === 0 && reestimated.length === 0) {
      return before; // identical set — a no-op writes nothing
    }

    for (const userId of removed) {
      await tx.taskAssignees.delete({ where: { taskId_userId: { taskId: id, userId } } });
    }
    for (const userId of added) {
      await tx.taskAssignees.create({
        data: { taskId: id, userId, estimateMinutes: next.get(userId)! },
      });
    }
    for (const userId of reestimated) {
      await tx.taskAssignees.update({
        where: { taskId_userId: { taskId: id, userId } },
        data: { estimateMinutes: next.get(userId)! },
      });
    }

    const task = await tx.task.findUnique({ where: { id } });
    await audit({
      action: "TaskAssigneesChanged",
      entityType: "task",
      entityId: id,
      data: { title: before.title, added, removed },
    });
    return task!;
  });
}

/**
 * `deleteTask` — refused while subtasks exist (`Restrict`; the count is named
 * in the message). Dependency edges and assignee rows are `Cascade` — they die
 * with the task, and their counts go into the audit row. `Ticket.taskId` and
 * `Task.ticketId` are `SetNull` — deleting the task must not destroy the
 * linked ticket either direction).
 */
export async function deleteTask(actor: AuditActor, id: string): Promise<Task> {
  return txWithAudit(actor, async (tx, audit) => {
    const task = await tx.task.findUnique({
      where: { id },
      include: {
        _count: { select: { subtasks: true, blockedBy: true, blocking: true, assignees: true } },
      },
    });
    if (!task) throw new NotFoundError(tr("work.err.task.notFound"));
    if (task._count.subtasks > 0) {
      throw new ValidationError({}, [
        tr(
          task._count.subtasks === 1
            ? "work.err.task.deleteWithSubtasks.one"
            : "work.err.task.deleteWithSubtasks.other",
          { title: task.title, count: task._count.subtasks },
        ),
      ]);
    }
    const deleted = await tx.task.delete({ where: { id } });
    await audit({
      action: "TaskDeleted",
      entityType: "task",
      entityId: id,
      data: {
        title: task.title,
        dependencyEdges: task._count.blockedBy + task._count.blocking,
        assignees: task._count.assignees,
      },
    });
    return deleted;
  });
}
