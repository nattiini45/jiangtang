import type { TaskStatus } from "~/generated/prisma/client";
import { SETTLED_TASK_STATUSES } from "./tasks.lanes";

/**
 * Task dates are DAY-granular: `startAt`/`dueAt` carry 00:00 Europe/
 * Berlin of the day the user picked (the schema's `optionalDate` parses a
 * `type="date"` value through `berlinLocalToUtc`), so "which day" is always a
 * Berlin question — never a host-local or UTC one. These helpers compare
 * Berlin calendar days; they are pure and client-safe.
 */

/** `en-CA` renders "YYYY-MM-DD" — comparable as a string once Berlin-anchored. */
const berlinDayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" });

/** The Berlin calendar day an instant falls on, "YYYY-MM-DD". */
export function berlinDayKey(date: Date | string): string {
  return berlinDayFmt.format(typeof date === "string" ? new Date(date) : date);
}

/**
 * "Overdue" = the task's Berlin due day is BEFORE today's Berlin day AND the
 * task is not settled (not DONE, not CANCELLED). A task due today is not
 * overdue yet; a DONE task is never overdue no matter how stale the date.
 */
export function isTaskOverdue(
  dueAt: Date | string | null | undefined,
  status: TaskStatus,
  now: Date = new Date(),
): boolean {
  if (!dueAt || SETTLED_TASK_STATUSES.has(status)) return false;
  return berlinDayKey(dueAt) < berlinDayKey(now);
}
