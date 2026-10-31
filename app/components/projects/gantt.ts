import { berlinDayIndex, dayIndexToDateKey, isoWeekNumber, isoWeekStart } from "~/lib/berlin-days";
import type { TaskStatus } from "~/generated/prisma/enums";
import { t } from "~/i18n";
import type { Locale } from "~/i18n/locales";

/**
 * Pure layout math for the project gantt — day-index units, no pixels.
 * The SVG component multiplies by its px-per-day scale; keeping the math unit-
 * free is what makes it testable. Every date is bucketed on the Berlin civil
 * calendar via `berlin-days.ts`.
 */

export interface GanttTask {
  id: string;
  title: string;
  status: TaskStatus;
  startAt: Date | string | null;
  dueAt: Date | string | null;
  parentTaskId: string | null;
  /** ids of tasks blocking this one (the arrow's other end). */
  blockerIds: string[];
  createdAt?: Date | string;
}

export interface GanttRow {
  task: GanttTask;
  /** 0 = root task, +1 per subtask level. */
  depth: number;
  /** Inclusive day indexes; a bar renders from `from` to `to + 1` on the axis. */
  bar?: { from: number; to: number };
  /** A due-only task renders as a diamond on this day index. */
  milestone?: number;
  overdue: boolean;
  done: boolean;
}

export interface GanttArrow {
  /** Row indexes into `rows`; the component turns them into y positions. */
  fromRow: number;
  toRow: number;
  /** Day units: the blocker bar's end edge → the blocked bar's start edge. */
  x0: number;
  x1: number;
}

export interface GanttLayout {
  /** Inclusive Berlin day-index span of the axis. */
  startDay: number;
  endDay: number;
  rows: GanttRow[];
  /** Tasks with neither startAt nor dueAt — rendered as a list below. */
  unscheduled: GanttTask[];
  /** ISO-week grid lines: the Monday of every week touching the range. */
  weeks: { day: number; label: string }[];
  /** Today's day index if inside the range, else null. */
  today: number | null;
  /** The project's own start→due span, drawn as a background band. */
  projectBand?: { from: number; to: number };
  arrows: GanttArrow[];
}

const DONEISH = new Set<string>(["DONE", "CANCELLED"]);

const dayOf = (d: Date | string | null | undefined): number | null =>
  d == null ? null : berlinDayIndex(typeof d === "string" ? new Date(d) : d);

export function buildGantt(input: {
  tasks: GanttTask[];
  projectStartAt?: Date | string | null;
  projectDueAt?: Date | string | null;
  today?: Date;
  /** Locale of the week-axis labels; defaults to German (the pinned test locale). */
  locale?: Locale;
}): GanttLayout {
  const locale = input.locale ?? "de";
  const todayDay = berlinDayIndex(input.today ?? new Date());
  const projStart = dayOf(input.projectStartAt);
  const projDue = dayOf(input.projectDueAt);

  // Hierarchy: roots in input order (the query sorts by position), each
  // followed depth-first by its subtasks. Orphaned parent ids degrade to root.
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const children = new Map<string | null, GanttTask[]>();
  for (const t of input.tasks) {
    const parent = t.parentTaskId && byId.has(t.parentTaskId) ? t.parentTaskId : null;
    const list = children.get(parent) ?? [];
    list.push(t);
    children.set(parent, list);
  }

  const rows: GanttRow[] = [];
  const unscheduled: GanttTask[] = [];
  const rowIndexById = new Map<string, number>();

  const visit = (task: GanttTask, depth: number) => {
    const from = dayOf(task.startAt);
    const to = dayOf(task.dueAt);
    const row: GanttRow = {
      task,
      depth,
      done: DONEISH.has(task.status),
      overdue: false,
    };
    if (from !== null && to !== null) {
      row.bar = { from: Math.min(from, to), to: Math.max(from, to) };
    } else if (from !== null) {
      row.bar = { from, to: from };
    } else if (to !== null) {
      row.milestone = to;
    } else {
      unscheduled.push(task);
      for (const child of children.get(task.id) ?? []) visit(child, depth + 1);
      return;
    }
    row.overdue = !row.done && to !== null && to < todayDay;
    rowIndexById.set(task.id, rows.length);
    rows.push(row);
    for (const child of children.get(task.id) ?? []) visit(child, depth + 1);
  };
  for (const t of children.get(null) ?? []) visit(t, 0);

  // Axis: all scheduled task days, the project band and today — padded by a
  // day on each side so edge bars never touch the frame.
  const days: number[] = [todayDay];
  for (const r of rows) {
    if (r.bar) days.push(r.bar.from, r.bar.to);
    if (r.milestone != null) days.push(r.milestone);
  }
  if (projStart != null) days.push(projStart);
  if (projDue != null) days.push(projDue);
  const startDay = Math.min(...days) - 1;
  const endDay = Math.max(...days) + 1;

  const weeks: { day: number; label: string }[] = [];
  for (let d = isoWeekStart(startDay); d <= endDay; d += 7) {
    weeks.push({
      day: d,
      label: t(locale, "projects.gantt.weekLabel", {
        week: String(isoWeekNumber(d).week).padStart(2, "0"),
      }),
    });
  }

  const arrows: GanttArrow[] = [];
  const endEdgeOf = (r: GanttRow) => (r.bar ? r.bar.to + 1 : r.milestone! + 0.5);
  const startEdgeOf = (r: GanttRow) => (r.bar ? r.bar.from : r.milestone! + 0.5);
  for (const r of rows) {
    const toRow = rowIndexById.get(r.task.id);
    if (toRow == null) continue;
    for (const blockerId of r.task.blockerIds) {
      const fromRow = rowIndexById.get(blockerId);
      if (fromRow == null) continue;
      const from = rows[fromRow];
      arrows.push({
        fromRow,
        toRow,
        x0: endEdgeOf(from),
        x1: startEdgeOf(r),
      });
    }
  }

  return {
    startDay,
    endDay,
    rows,
    unscheduled,
    weeks,
    today: todayDay >= startDay && todayDay <= endDay ? todayDay : null,
    projectBand:
      projStart != null && projDue != null ? { from: projStart, to: projDue + 1 } : undefined,
    arrows,
  };
}

/** "YYYY-MM-DD" label for a day index — axis tooltips and tests. */
export function ganttDayKey(dayIndex: number): string {
  return dayIndexToDateKey(dayIndex);
}

// ---------------------------------------------------------------------------
// Burndown
// ---------------------------------------------------------------------------

export interface BurndownTask {
  id: string;
  estimateMinutes: number | null;
  createdAt: Date | string;
}

/**
 * One activity row normalized by the loader: `to` is the resulting status for
 * `TaskCreated`/`TaskStatusChanged`/`TaskMoved` (`data.status`, `data.to`,
 * `data.toStatus`); `action: "TaskDeleted"` needs no `to`.
 */
export interface BurndownEvent {
  taskId: string;
  occurredAt: Date | string;
  action: string;
  to?: string | null;
}

export interface BurndownPoint {
  /** "YYYY-MM-DD" (Berlin). */
  day: string;
  /** Σ estimateMinutes of tasks alive and not DONE/CANCELLED at day's end. */
  remaining: number;
}

/**
 * Reconstruct remaining-estimate history from the audit log. Estimates are
 * today's values (estimate edits are not replayable — `TaskUpdated` records no
 * estimate fields); status history is reconstructed end-of-day per Berlin day.
 * O(tasks × days), fine for a project-sized set.
 */
export function computeBurndown(
  tasks: BurndownTask[],
  events: BurndownEvent[],
  range: { startDay: number; endDay: number },
): BurndownPoint[] {
  const byTask = new Map<
    string,
    { changes: { day: number; to: string }[]; deletedDay: number | null; createdDay: number }
  >();
  for (const t of tasks) {
    byTask.set(t.id, {
      changes: [],
      deletedDay: null,
      createdDay: berlinDayIndex(
        typeof t.createdAt === "string" ? new Date(t.createdAt) : t.createdAt,
      ),
    });
  }
  for (const e of events) {
    const slot = byTask.get(e.taskId);
    if (!slot) continue;
    const day = berlinDayIndex(
      typeof e.occurredAt === "string" ? new Date(e.occurredAt) : e.occurredAt,
    );
    if (e.action === "TaskDeleted") {
      slot.deletedDay = day;
    } else if (e.to != null) {
      slot.changes.push({ day, to: e.to });
    }
  }
  for (const slot of byTask.values()) {
    slot.changes.sort((a, b) => a.day - b.day);
  }

  const points: BurndownPoint[] = [];
  for (let d = range.startDay; d <= range.endDay; d++) {
    let remaining = 0;
    for (const t of tasks) {
      const slot = byTask.get(t.id)!;
      if (slot.createdDay > d) continue; // not yet created
      if (slot.deletedDay != null && slot.deletedDay <= d) continue; // gone
      let status: string | null = null;
      for (const c of slot.changes) {
        if (c.day > d) break;
        status = c.to;
      }
      // A task with no recorded status event predates the log's reach —
      // count it as open (TaskCreated always carries its status when the
      // loader includes it, so `null` means "born before logging").
      if (status != null && DONEISH.has(status)) continue;
      remaining += t.estimateMinutes ?? 0;
    }
    points.push({ day: dayIndexToDateKey(d), remaining });
  }
  return points;
}

/**
 * Chart range for the burndown. Starts at the LATER of the project start and
 * the first task's creation day — a project created months before its tasks
 * would otherwise plot a flat zero prefix. Ends at the later of today and
 * `dueAt`. Returns `dueDay` separately so the caller can decide whether the
 * ideal line exists at all.
 */
export function burndownRange(input: {
  tasks: BurndownTask[];
  projectStartAt?: Date | string | null;
  projectDueAt?: Date | string | null;
  today?: Date;
}): { startDay: number; endDay: number; dueDay: number | null } {
  const todayDay = berlinDayIndex(input.today ?? new Date());
  const dueDay = dayOf(input.projectDueAt);
  const projStart = dayOf(input.projectStartAt);
  const firstCreated = input.tasks.reduce<number | null>((min, t) => {
    const d = berlinDayIndex(typeof t.createdAt === "string" ? new Date(t.createdAt) : t.createdAt);
    return min == null || d < min ? d : min;
  }, null);
  const startDay =
    projStart == null && firstCreated == null
      ? todayDay
      : Math.max(projStart ?? Number.MIN_SAFE_INTEGER, firstCreated ?? Number.MIN_SAFE_INTEGER);
  return { startDay, endDay: Math.max(todayDay, dueDay ?? todayDay), dueDay };
}

/**
 * Ideal-line value at `day`: linear from `startRemaining` at `startDay` to 0 at
 * `dueDay`. Returns null while `dueDay` is unset or the line is degenerate.
 */
export function idealRemaining(
  startRemaining: number,
  startDay: number,
  dueDay: number | null,
  day: number,
): number | null {
  if (dueDay == null || dueDay <= startDay) return null;
  return Math.max(0, startRemaining * (1 - (day - startDay) / (dueDay - startDay)));
}
