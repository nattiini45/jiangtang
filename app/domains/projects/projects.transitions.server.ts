import type { ProjectStatus } from "~/generated/prisma/client";
import { tr } from "~/i18n/request-locale.server";
import { TransitionError } from "~/lib/errors.server";
import {
  PROJECT_STATUS_POLICY,
  PROJECT_TRANSITIONS,
  projectActionMetadata,
} from "./projects.transitions";

export function requireProjectTransition(
  currentState: ProjectStatus,
  attemptedTarget: ProjectStatus,
) {
  const edge = PROJECT_TRANSITIONS[currentState].find(({ target }) => target === attemptedTarget);
  if (edge) return edge;
  const message = tr(PROJECT_STATUS_POLICY.reasonKey);
  throw new TransitionError(
    {
      entity: "project",
      currentState,
      attemptedTarget,
      ...projectActionMetadata(currentState),
      reason: { code: "INVALID_TRANSITION", message },
    },
    { status: [message] },
  );
}
