import type { MessageKey } from "~/i18n";

export interface TransitionRejection {
  entity: string;
  currentState: string;
  attemptedTarget: string;
  allowedTransitions: string[];
  allowedActions: Array<{
    target: string;
    labelKey: MessageKey;
    requiredFields: readonly string[];
    allowed: boolean;
  }>;
  reason: { code: string; message: string };
}
