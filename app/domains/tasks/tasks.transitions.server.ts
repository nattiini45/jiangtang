import type { TaskStatus } from "~/generated/prisma/client";
import { tr } from "~/i18n/request-locale.server";
import { TransitionError } from "~/lib/errors.server";
import { TASK_STATUS_POLICY, TASK_TRANSITIONS, taskActionMetadata } from "./tasks.transitions";

export function requireTaskTransition(currentState: TaskStatus, attemptedTarget: TaskStatus) {
  const edge = TASK_TRANSITIONS[currentState].find(({ target }) => target === attemptedTarget);
  if (edge) return edge;
  const message = tr(TASK_STATUS_POLICY.reasonKey);
  throw new TransitionError(
    {
      entity: "task",
      currentState,
      attemptedTarget,
      ...taskActionMetadata(currentState),
      reason: { code: "INVALID_TRANSITION", message },
    },
    { status: [message] },
  );
}
