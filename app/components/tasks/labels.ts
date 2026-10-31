import { TaskPriority, TaskStatus } from "~/generated/prisma/enums";
import { t } from "~/i18n";
import type { Locale } from "~/i18n/locales";

/**
 * Task labels, re-exported for the components layer. The label functions
 * live in `~/lib/status` because the domain schema's CSV grammar consumes them
 * and a domain must not import `~/components`.
 */
export { taskStatusLabel, taskPriorityLabel } from "~/lib/status";

/** UI iteration order for the `TaskStatus` enum — board-ish order, settled last. */
export const TASK_STATUSES = [
  TaskStatus.BACKLOG,
  TaskStatus.TODO,
  TaskStatus.IN_PROGRESS,
  TaskStatus.IN_REVIEW,
  TaskStatus.BLOCKED,
  TaskStatus.DONE,
  TaskStatus.CANCELLED,
] as const;

/** UI iteration order for `TaskPriority`, urgent first. */
export const TASK_PRIORITIES = [
  TaskPriority.URGENT,
  TaskPriority.HIGH,
  TaskPriority.MEDIUM,
  TaskPriority.LOW,
  TaskPriority.LOWEST,
] as const;

/** The lane titles the board renders, keyed by `LANES` member. */
export function laneTitle(
  locale: Locale,
  lane: "BACKLOG" | "IN_PROGRESS" | "IN_REVIEW" | "DONE" | "CANCELLED",
): string {
  return t(locale, `tasks.lane.${lane}`);
}
