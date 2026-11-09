import type { TicketStatus } from "~/generated/prisma/client";
import type { MessageKey } from "~/i18n";
import type { TransitionRejection } from "~/lib/transitions";

type TicketEdge = {
  target: TicketStatus;
  labelKey: MessageKey;
  requiredFields: readonly "resolution"[];
  effect: "resolve" | "clearResolution" | "preserveResolution";
  audit: "TicketResolved" | "TicketStarted" | "TicketReopened" | "TicketCancelled";
};

const start = {
  target: "IN_PROGRESS",
  labelKey: "tickets.detail.takeInProgress",
  requiredFields: [],
  effect: "clearResolution",
  audit: "TicketStarted",
} as const satisfies TicketEdge;
const reopen = {
  target: "OPEN",
  labelKey: "tickets.detail.reopen",
  requiredFields: [],
  effect: "clearResolution",
  audit: "TicketReopened",
} as const satisfies TicketEdge;
const resolve = {
  target: "RESOLVED",
  labelKey: "tickets.detail.resolve",
  requiredFields: ["resolution"],
  effect: "resolve",
  audit: "TicketResolved",
} as const satisfies TicketEdge;
const cancel = {
  target: "CANCELLED",
  labelKey: "common.cancel",
  requiredFields: [],
  effect: "preserveResolution",
  audit: "TicketCancelled",
} as const satisfies TicketEdge;

export const TICKET_TRANSITIONS = {
  OPEN: [start, resolve, cancel],
  IN_PROGRESS: [reopen, resolve, cancel],
  RESOLVED: [reopen, start],
  CANCELLED: [reopen, start],
} as const satisfies Record<TicketStatus, readonly TicketEdge[]>;

export interface TicketAction {
  target: TicketStatus;
  labelKey: MessageKey;
  requiredFields: readonly "resolution"[];
  allowed: true;
}

export function ticketAllowedActions(status: TicketStatus): TicketAction[] {
  return TICKET_TRANSITIONS[status].map(({ target, labelKey, requiredFields }) => ({
    target,
    labelKey,
    requiredFields,
    allowed: true,
  }));
}

export function ticketActionMetadata(status: TicketStatus) {
  const allowedActions = ticketAllowedActions(status);
  return { allowedTransitions: allowedActions.map((action) => action.target), allowedActions };
}

export interface TicketTransitionRejection extends TransitionRejection {
  entity: "ticket";
  currentState: TicketStatus;
  attemptedTarget: string;
  allowedTransitions: TicketStatus[];
  allowedActions: TicketAction[];
  reason: {
    code: "INVALID_TRANSITION" | "RESOLUTION_REQUIRED" | "UNSUPPORTED_LANE";
    message: string;
  };
}
