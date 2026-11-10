import { tr } from "~/i18n/request-locale.server";
import { Prisma } from "~/generated/prisma/client";
import type { Task, TaskStatus } from "~/generated/prisma/client";
import { hasPermission } from "~/lib/rbac.server";
import type { AuditActor } from "~/lib/audit.server";
import { db } from "~/lib/db.server";
import { NotFoundError } from "~/lib/errors.server";
import { berlinLocalToUtc } from "~/lib/time.server";
import { berlinDayIndex, berlinDayStartMs, isoWeekNumber, isoWeekStart } from "~/lib/berlin-days";
import { computeCapacity, type CapacityRow } from "./capacity";
import { unionMinutes } from "~/domains/time/time-utils";
import {
  LANES,
  LANE_TASK_STATUSES,
  laneOfTaskStatus,
  SETTLED_TASK_STATUSES,
  type Lane,
} from "./tasks.lanes";
import { berlinDayKey } from "./tasks.dates";
import type { TaskListOptions } from "./tasks.schema";
import { taskActionMetadata } from "./tasks.transitions";

/**
 * Tasks-domain queries. Reads only — every mutating caller opens its own
 * transaction through `txWithAudit`.
 *
 * Lane order is a TS-level mapping (`tasks.lanes.ts`, mirrored from
 * `workitem_lane`), not a column — so `listBoardTasks` sorts in JS rather than
 * duplicating the mapping in a SQL CASE that could drift from both.
 */

/** Filter → `where` shared by `listTasks` and `listBoardTasks`. */
function taskWhere(options: TaskListOptions): Prisma.TaskWhereInput {
  return {
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.statuses?.length ? { status: { in: options.statuses } } : {}),
    ...(options.assigneeId ? { assignees: { some: { userId: options.assigneeId } } } : {}),
    ...(options.label ? { labels: { has: options.label } } : {}),
    ...(options.q
      ? {
          OR: [
            { title: { contains: options.q, mode: "insensitive" as const } },
            { body: { contains: options.q, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(options.dueFrom || options.dueTo
      ? {
          dueAt: {
            ...(options.dueFrom ? { gte: options.dueFrom } : {}),
            ...(options.dueTo ? { lte: options.dueTo } : {}),
          },
        }
      : {}),
  };
}

const TASK_USER = { select: { id: true, name: true, initials: true } } as const;

/** A task's assignee row: the user, plus that user's share of the estimate. */
const TASK_ASSIGNEES = {
  select: { userId: true, estimateMinutes: true, user: TASK_USER },
} as const;

/**
 * `listTasks` — the filterable flat list: project, statuses, assignee,
 * label, text (title OR body), due window. Ordered by updatedAt desc so the
 * most recently touched work surfaces first — lane ordering is the board's
 * job, not the list's. Each row carries `isBlocked` like {@link listBoardTasks}
 * (the list shows the same blocked marker the board does).
 */
export async function listTasks(
  options: TaskListOptions = {},
  page: { offset?: number; limit?: number } = {},
) {
  const tasks = await db.task.findMany({
    skip: page.offset,
    take: page.limit,
    where: taskWhere(options),
    include: {
      project: { select: { id: true, name: true, slug: true, color: true } },
      assignees: TASK_ASSIGNEES,
      parentTask: { select: { id: true, title: true } },
      blockedBy: {
        select: { blocking: { select: { status: true } } },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  return tasks.map((t) => {
    const { blockedBy, ...task } = t;
    return {
      ...task,
      isBlocked: blockedBy.some((edge) => !SETTLED_TASK_STATUSES.has(edge.blocking.status)),
    };
  });
}

/** A blocker edge → the blocker, boiled down to what a card needs to render. */
const DEPENDENCY_SUMMARY = {
  select: {
    blockingTaskId: true,
    blockedByTaskId: true,
    blocking: { select: { id: true, title: true, status: true } },
    blockedBy: { select: { id: true, title: true, status: true } },
  },
} as const;

/**
 * `getTask(id)` — the detail-read the `/tasks/:id` route composes: project,
 * assignees (user + per-assignee estimate), both directions of the dependency
 * graph (`blockedBy` = the tasks blocking THIS one, `blocking` = the tasks it
 * blocks), subtasks, parent, the linked ticket (`ticketId`) and tickets this task is
 * the primary task of (`primaryForTickets`), location, creator.
 */
export async function getTask(id: string) {
  const task = await db.task.findUnique({
    where: { id },
    include: {
      project: { select: { id: true, name: true, slug: true } },
      assignees: TASK_ASSIGNEES,
      blockedBy: DEPENDENCY_SUMMARY,
      blocking: DEPENDENCY_SUMMARY,
      subtasks: {
        select: { id: true, title: true, status: true },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      },
      parentTask: { select: { id: true, title: true } },
      ticket: { select: { id: true, title: true, status: true } },
      primaryForTickets: { select: { id: true, title: true, status: true } },
      location: { select: { id: true, name: true } },
      createdBy: TASK_USER,
    },
  });
  return task ? { ...task, ...taskActionMetadata(task.status) } : null;
}

/** Like {@link getTask} but throws — for mutations that refuse a missing row. */
export async function requireTask(id: string) {
  const task = await db.task.findUnique({ where: { id } });
  if (!task) throw new NotFoundError(tr("work.err.task.notFound"));
  return task;
}

/**
 * Options for the "Blockiert durch" picker: open tasks only — a DONE or
 * CANCELLED task can block nothing that matters — excluding the task itself
 * (the self-edge the mutation refuses anyway, filtered one step earlier).
 */
export function listOpenTaskOptions(excludeId: string) {
  return db.task.findMany({
    where: { id: { not: excludeId }, status: { notIn: [...SETTLED_TASK_STATUSES] } },
    select: { id: true, title: true, status: true },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: 200,
  });
}

export interface BoardTask extends Task {
  project: { id: string; name: string; slug: string; color: string | null } | null;
  assignees: Array<{
    userId: string;
    estimateMinutes: number | null;
    user: { id: string; name: string; initials: string | null };
  }>;
  lane: Lane;
  /** Has at least one blocker whose status is neither DONE nor CANCELLED. */
  isBlocked: boolean;
}

/**
 * `listBoardTasks({ projectId?, assigneeId? })` — the board's read: every task
 * with its lane, ordered **lane → position → id** (position is only comparable
 * inside a lane, which is why lane leads), and `isBlocked` = has a blocker that
 * is not DONE/CANCELLED.
 */
export async function listBoardTasks(
  options: { projectId?: string; assigneeId?: string } = {},
  page?: { lane: Lane; offset: number; limit: number },
) {
  const tasks = await db.task.findMany({
    where: taskWhere({
      projectId: options.projectId,
      assigneeId: options.assigneeId,
      ...(page ? { statuses: LANE_TASK_STATUSES[page.lane] } : {}),
    }),
    ...(page
      ? {
          skip: page.offset,
          take: page.limit,
          orderBy: [{ position: "asc" as const }, { id: "asc" as const }],
        }
      : {}),
    include: {
      project: { select: { id: true, name: true, slug: true, color: true } },
      assignees: TASK_ASSIGNEES,
      blockedBy: {
        select: { blocking: { select: { status: true } } },
      },
    },
  });

  return tasks
    .map((t): BoardTask => {
      const { blockedBy, ...task } = t;
      return {
        ...task,
        lane: laneOfTaskStatus(task.status),
        isBlocked: blockedBy.some((edge) => !SETTLED_TASK_STATUSES.has(edge.blocking.status)),
      };
    })
    .sort((a, b) => {
      const lane = LANES.indexOf(a.lane) - LANES.indexOf(b.lane);
      if (lane !== 0) return lane;
      const position = a.position.comparedTo(b.position);
      if (position !== 0) return position;
      return a.id.localeCompare(b.id);
    });
}

// ── Dashboard reads ──────────────────────────────────────────────────────────

/** `status` filter shared by the dashboard reads — anything not DONE/CANCELLED. */
const OPEN_STATUS: Prisma.TaskWhereInput["status"] = { notIn: [...SETTLED_TASK_STATUSES] };

/**
 * [Berlin-midnight, next Berlin-midnight) for a `YYYY-MM-DD` key — DST-correct
 * because each bound is resolved through `berlinLocalToUtc` rather than
 * `key + 86400s` (Berlin days are 23/24/25 h).
 */
function berlinDayRange(dayKey: string): [Date, Date] {
  const [y, m, d] = dayKey.split("-").map(Number);
  const nextKey = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10);
  return [berlinLocalToUtc(`${dayKey}T00:00`), berlinLocalToUtc(`${nextKey}T00:00`)];
}

export interface DueSummary {
  dueToday: Array<Pick<Task, "id" | "title" | "status" | "dueAt">>;
  dueTodayCount: number;
  overdueCount: number;
}

/**
 * Dashboard „Heute fällig": open tasks whose Berlin due day IS today,
 * plus the count of still-open tasks whose due day is already past. A task due
 * at 23:30 Berlin is due *today* even though the stored instant can sit in the
 * next UTC day — the bounds are Berlin midnights, not UTC ones.
 */
export async function getDueSummary(now = new Date()): Promise<DueSummary> {
  const [start, end] = berlinDayRange(berlinDayKey(now));
  const todayWhere = {
    status: OPEN_STATUS,
    dueAt: { gte: start, lt: end },
  } satisfies Prisma.TaskWhereInput;
  const [dueToday, dueTodayCount, overdueCount] = await Promise.all([
    db.task.findMany({
      where: todayWhere,
      select: { id: true, title: true, status: true, dueAt: true },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: 5,
    }),
    db.task.count({ where: todayWhere }),
    db.task.count({ where: { status: OPEN_STATUS, dueAt: { lt: start } } }),
  ]);
  return { dueToday, dueTodayCount, overdueCount };
}

export interface BlockedTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  dueAt: Date | null;
  openBlockers: Array<{ id: string; title: string; status: TaskStatus }>;
}

/**
 * Dashboard „Blockiert": open tasks that carry the BLOCKED status OR at
 * least one blocker that is itself still open — the same definition the
 * `isBlocked` marker on list/board rows uses.
 */
export async function listBlockedTasks(limit = 5): Promise<BlockedTaskRow[]> {
  const tasks = await db.task.findMany({
    where: {
      status: OPEN_STATUS,
      OR: [{ status: "BLOCKED" }, { blockedBy: { some: { blocking: { status: OPEN_STATUS } } } }],
    },
    select: {
      id: true,
      title: true,
      status: true,
      dueAt: true,
      blockedBy: { select: { blocking: { select: { id: true, title: true, status: true } } } },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: limit,
  });
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    dueAt: t.dueAt,
    openBlockers: t.blockedBy
      .map((e) => e.blocking)
      .filter((b) => !SETTLED_TASK_STATUSES.has(b.status)),
  }));
}

export interface MyWorkSummary {
  tasks: Array<
    Pick<Task, "id" | "title" | "status" | "dueAt" | "estimateMinutes"> & {
      project: { name: string; slug: string; color: string | null } | null;
    }
  >;
  taskCount: number;
  /** Σ my share across ALL my open tasks (not just the listed ones). */
  estimateMinutes: number;
}

/**
 * Dashboard „Meine Arbeit": the user's open tasks plus the estimate
 * total. The share follows: `TaskAssignees.estimateMinutes` when the
 * user carries one, otherwise `Task.estimateMinutes ÷ assignee count`.
 */
export async function getMyWork(userId: string, limit = 5): Promise<MyWorkSummary> {
  const mine = await db.task.findMany({
    where: { status: OPEN_STATUS, assignees: { some: { userId } } },
    select: {
      id: true,
      title: true,
      status: true,
      dueAt: true,
      estimateMinutes: true,
      project: { select: { name: true, slug: true, color: true } },
      assignees: TASK_ASSIGNEES,
    },
    orderBy: [{ dueAt: "asc" }, { updatedAt: "desc" }],
  });
  const estimateMinutes = mine.reduce((sum, t) => {
    const share =
      t.assignees.find((a) => a.userId === userId)?.estimateMinutes ??
      (t.estimateMinutes !== null && t.assignees.length > 0
        ? t.estimateMinutes / t.assignees.length
        : 0);
    return sum + share;
  }, 0);
  const tasks = mine.slice(0, limit).map(({ assignees: _a, ...t }) => t);
  return { tasks, taskCount: mine.length, estimateMinutes };
}

export interface CapacityOverview {
  /** The 6 ISO weeks, index 0 = the current week. */
  weeks: { isoWeek: string; startDay: number }[];
  todayIndex: number;
  rows: CapacityRow[];
}

/**
 * Workload heatmap: every ACTIVE user × the next 6 Berlin ISO
 * weeks. Demand comes from open tasks' due dates; `computeCapacity` owns the
 * share/over math. The current week's column also carries the unioned minutes
 * already logged (`TimeEntry`; overlaps count once).
 */
export async function getCapacityOverview(
  actor: AuditActor,
  now = new Date(),
): Promise<CapacityOverview> {
  const todayIndex = berlinDayIndex(now);
  const week0 = isoWeekStart(todayIndex);
  const weeks = Array.from({ length: 6 }, (_, i) => {
    const startDay = week0 + i * 7;
    const { year, week } = isoWeekNumber(startDay);
    return { isoWeek: `${year}-W${String(week).padStart(2, "0")}`, startDay };
  });

  const [users, tasks] = await Promise.all([
    db.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, initials: true, weeklyCapacityMinutes: true },
      orderBy: { name: "asc" },
    }),
    db.task.findMany({
      where: { status: OPEN_STATUS },
      select: {
        id: true,
        title: true,
        status: true,
        dueAt: true,
        estimateMinutes: true,
        assignees: { select: { userId: true, estimateMinutes: true } },
      },
    }),
  ]);

  const viewOthers = await hasPermission(actor, "time.viewOthers");
  const weekStartMs = berlinDayStartMs(week0);
  const weekEndMs = berlinDayStartMs(week0 + 7);
  const entries = await db.timeEntry.findMany({
    where: {
      ...(!viewOthers ? { userId: actor.id ?? "" } : {}),
      startsAt: { lt: new Date(weekEndMs) },
      OR: [{ endsAt: null }, { endsAt: { gt: new Date(weekStartMs) } }],
    },
    select: { userId: true, startsAt: true, endsAt: true },
  });
  const byUser = new Map<string, { start: number; end: number }[]>();
  for (const e of entries) {
    const start = Math.max(e.startsAt.getTime(), weekStartMs);
    const end = Math.min((e.endsAt ?? now).getTime(), weekEndMs);
    if (end <= start) continue;
    const list = byUser.get(e.userId) ?? [];
    list.push({ start, end });
    byUser.set(e.userId, list);
  }
  const loggedCurrentWeek = new Map(
    [...byUser].map(([userId, iv]) => [userId, unionMinutes(iv)] as const),
  );

  const rows = computeCapacity({ users, tasks, weeks, loggedCurrentWeek });
  for (const row of rows) {
    if (!viewOthers && row.userId !== actor.id) for (const week of row.weeks) delete week.logged;
  }
  return { weeks, todayIndex, rows };
}
