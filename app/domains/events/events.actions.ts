import type { EventStatus } from "~/generated/prisma/client";
import type { MessageKey } from "~/i18n";

export const EVENT_REOPEN_ACTION = {
  intent: "reopenEvent",
  from: "CANCELLED",
  target: "PLANNED",
  labelKey: "events.detail.reopen",
  hintKey: "events.detail.reopenHint",
} as const satisfies {
  intent: string;
  from: EventStatus;
  target: EventStatus;
  labelKey: MessageKey;
  hintKey: MessageKey;
};

export function eventAllowedActions(status: EventStatus) {
  return status === EVENT_REOPEN_ACTION.from ? [EVENT_REOPEN_ACTION] : [];
}
