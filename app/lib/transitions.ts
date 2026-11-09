import type { MessageKey } from "~/i18n";

export interface TransitionAction<State extends string = string> {
  target: State;
  labelKey: MessageKey;
  requiredFields: readonly string[];
  allowed: boolean;
}

export interface TransitionRejection {
  entity: string;
  currentState: string;
  attemptedTarget: string;
  allowedTransitions: string[];
  allowedActions: TransitionAction[];
  reason: { code: string; message: string };
}
