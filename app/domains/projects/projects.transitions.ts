import { ProjectStatus } from "~/generated/prisma/enums";
import type { MessageKey } from "~/i18n";
import type { TransitionAction } from "~/lib/transitions";

export const PROJECT_STATUS_POLICY = {
  audit: "ProjectStatusChanged",
  reasonKey: "work.err.project.statusAlready",
} as const;

type ProjectEdge = typeof PROJECT_STATUS_POLICY & {
  target: ProjectStatus;
  effect: { status: ProjectStatus };
  labelKey: MessageKey;
  requiredFields: readonly string[];
};

const states = Object.values(ProjectStatus);
export const PROJECT_TRANSITIONS = Object.fromEntries(
  states.map((current) => [
    current,
    states
      .filter((target) => target !== current)
      .map((target): ProjectEdge => ({
        ...PROJECT_STATUS_POLICY,
        target,
        effect: { status: target },
        labelKey: `status.project.${target}`,
        requiredFields: [],
      })),
  ]),
) as Record<ProjectStatus, ProjectEdge[]>;

export function projectAllowedActions(status: ProjectStatus): TransitionAction<ProjectStatus>[] {
  return PROJECT_TRANSITIONS[status].map(({ target, labelKey, requiredFields }) => ({
    target,
    labelKey,
    requiredFields,
    allowed: true,
  }));
}

export function projectActionMetadata(status: ProjectStatus) {
  const allowedActions = projectAllowedActions(status);
  return { allowedTransitions: allowedActions.map((action) => action.target), allowedActions };
}

export const PROJECT_RESTORE_AUDIT = {
  create: "ProjectImported",
  update: "ProjectUpdated",
} as const;
