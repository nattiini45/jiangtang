import type { TaskStatus } from "~/generated/prisma/enums";
import { berlinDayIndex } from "~/lib/berlin-days";

/**
 * Pure capacity math. Demand = for each active user and each of
 * the next `weeks.length` ISO weeks (Berlin), the sum over that user's OPEN
 * tasks due in that week of their share: `TaskAssignees.estimateMinutes` when
 * set, else the task's `estimateMinutes` ÷ assignee count. A task with no
 * assignees contributes to nobody — it is backlog, not workload. Tasks with no
 * `dueAt` are counted separately as „ohne Termin".
 */

export interface CapacityUser {
  id: string;
  name: string;
  initials: string | null;
  /** null = unset — the view must not manufacture a fake 0 h. */
  weeklyCapacityMinutes: number | null;
}

export interface CapacityTaskAssignee {
  userId: string;
  estimateMinutes: number | null;
}

export interface CapacityTask {
  id: string;
  title: string;
  status: TaskStatus;
  dueAt: Date | string | null;
  estimateMinutes: number | null;
  assignees: CapacityTaskAssignee[];
}

export interface CapacityWeek {
  isoWeek: string;
  /** demand in minutes */
  demand: number;
  /** union minutes logged — only the current week carries this */
  logged?: number;
  /** demand > capacity — only meaningful when capacity is set */
  over: boolean;
}

export interface CapacityRow {
  userId: string;
  name: string;
  initials: string | null;
  capacityMinutes: number | null;
  weeks: CapacityWeek[];
  /** Minutes of the user's share on open tasks with no due date. */
  noDue: number;
  /** Count of such tasks (for the label). */
  noDueCount: number;
}

const SETTLED = new Set<string>(["DONE", "CANCELLED"]);

const dueDayOf = (d: Date | string | null): number | null =>
  d == null ? null : berlinDayIndex(typeof d === "string" ? new Date(d) : d);

/** The user's share of a task in minutes (equal-share apportionment). */
export function taskShare(task: CapacityTask, userId: string): number {
  const me = task.assignees.filter((a) => a.userId === userId);
  if (me.length === 0) return 0;
  if (me[0].estimateMinutes != null) return me[0].estimateMinutes;
  if (task.estimateMinutes != null && task.assignees.length > 0) {
    return task.estimateMinutes / task.assignees.length;
  }
  return 0;
}

export function computeCapacity(input: {
  users: CapacityUser[];
  tasks: CapacityTask[];
  weeks: { startDay: number; isoWeek: string }[];
  /** Union minutes logged per userId inside weeks[0] (the current week). */
  loggedCurrentWeek: Map<string, number>;
}): CapacityRow[] {
  const openTasks = input.tasks.filter((t) => !SETTLED.has(t.status));

  return input.users.map((u) => {
    const weeks: CapacityWeek[] = input.weeks.map((w, i) => {
      let demand = 0;
      for (const t of openTasks) {
        const due = dueDayOf(t.dueAt);
        if (due == null || due < w.startDay || due >= w.startDay + 7) continue;
        demand += taskShare(t, u.id);
      }
      const cap = u.weeklyCapacityMinutes;
      return {
        isoWeek: w.isoWeek,
        demand: Math.round(demand),
        logged: i === 0 ? (input.loggedCurrentWeek.get(u.id) ?? 0) : undefined,
        over: cap != null && demand > cap,
      };
    });

    let noDue = 0;
    let noDueCount = 0;
    for (const t of openTasks) {
      if (t.dueAt != null) continue;
      const share = taskShare(t, u.id);
      if (share > 0) {
        noDue += share;
        noDueCount += 1;
      }
    }

    return {
      userId: u.id,
      name: u.name,
      initials: u.initials,
      capacityMinutes: u.weeklyCapacityMinutes,
      weeks,
      noDue: Math.round(noDue),
      noDueCount,
    };
  });
}
