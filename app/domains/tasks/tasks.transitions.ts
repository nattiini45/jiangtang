import { TaskStatus } from "~/generated/prisma/enums";
import type { MessageKey } from "~/i18n";
import type { TransitionAction } from "~/lib/transitions";
import { laneOfTaskStatus, TASK_LANE_DEFAULT_STATUS, type Lane } from "./tasks.lanes";

export const TASK_STATUS_POLICY = {
  audit: "TaskStatusChanged",
  reasonKey: "work.err.task.statusAlready",
} as const;

type TaskEdge = typeof TASK_STATUS_POLICY & {
  target: TaskStatus;
  effect: { status: TaskStatus; lane: Lane };
  labelKey: MessageKey;
  requiredFields: readonly string[];
};

const states = Object.values(TaskStatus);
export const TASK_TRANSITIONS = Object.fromEntries(
  states.map((current) => [
    current,
    states
      .filter((target) => target !== current)
      .map((target): TaskEdge => ({
        ...TASK_STATUS_POLICY,
        target,
        effect: { status: target, lane: laneOfTaskStatus(target) },
        labelKey: `status.task.${target}`,
        requiredFields: [],
      })),
  ]),
) as Record<TaskStatus, TaskEdge[]>;

export function taskAllowedActions(status: TaskStatus): TransitionAction<TaskStatus>[] {
  return TASK_TRANSITIONS[status].map(({ target, labelKey, requiredFields }) => ({
    target,
    labelKey,
    requiredFields,
    allowed: true,
  }));
}

export function taskActionMetadata(status: TaskStatus) {
  const allowedActions = taskAllowedActions(status);
  return { allowedTransitions: allowedActions.map((action) => action.target), allowedActions };
}

export const TASK_MOVE_POLICY = {
  audit: "TaskMoved",
} as const;

export function taskMoveStatus(current: TaskStatus, lane: Lane): TaskStatus {
  return laneOfTaskStatus(current) === lane ? current : TASK_LANE_DEFAULT_STATUS[lane];
}

export const TASK_RESTORE_AUDIT = { create: "TaskImported", update: "TaskUpdated" } as const;
