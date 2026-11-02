import type {
  EquipmentStatus,
  EventStatus,
  ProjectStatus,
  RoomStatus,
  StockStatus,
  TaskPriority,
  TaskStatus,
  TicketStatus,
} from "~/generated/prisma/client";
import {
  StockStatus as StockStatusEnum,
  TaskPriority as TaskPriorityEnum,
  TaskStatus as TaskStatusEnum,
} from "~/generated/prisma/enums";
import { enumAliasMap } from "~/i18n/aliases";
import { t, type MessageKey } from "~/i18n";
import type { Locale } from "~/i18n/locales";

/**
 * Status → token mapping (pure; client-safe). Maps each domain status enum to a
 * frozen tone, a localized label, and Tailwind classes for a status pill. Tracks
 * pass enum values in; never re-implement the color mapping. Labels live in the
 * i18n catalog (`status.*` keys); this module owns only the tones.
 */

export type StatusTone = "operational" | "fault" | "warning" | "info" | "neutral";

export interface StatusToken {
  tone: StatusTone;
  label: string;
  className: string;
  /** Full-strength fill for a status dot beside the label. */
  dotClassName: string;
}

/* A 15% tint of the status color with foreground text: the color marks the
   status while the label keeps body contrast on either theme. Colored text on
   its own tint cannot reach 4.5:1 on the dark canvas (axe color-contrast). */
const TONE_CLASS: Record<StatusTone, string> = {
  operational: "bg-status-operational/15 text-foreground border-transparent",
  fault: "bg-status-fault/15 text-foreground border-transparent",
  warning: "bg-status-warning/15 text-foreground border-transparent",
  info: "bg-status-info/15 text-foreground border-transparent",
  neutral: "bg-tint text-foreground border-transparent",
};

const DOT_CLASS: Record<StatusTone, string> = {
  operational: "bg-status-operational",
  fault: "bg-status-fault",
  warning: "bg-status-warning",
  info: "bg-status-info",
  neutral: "bg-muted-foreground",
};

export function toneClassName(tone: StatusTone): string {
  return TONE_CLASS[tone];
}

export function toneDotClassName(tone: StatusTone): string {
  return DOT_CLASS[tone];
}

const ROOM: Record<RoomStatus, StatusTone> = {
  ALL_GOOD: "operational",
  PROVISIONAL: "warning",
  MAINTENANCE_NEEDED: "warning",
  TECH_DEFECT: "fault",
  OUT_OF_SERVICE: "neutral",
};

const EQUIPMENT: Record<EquipmentStatus, StatusTone> = {
  OPERATIONAL: "operational",
  FAULTY: "fault",
  MAINTENANCE: "warning",
  RETIRED: "neutral",
};

const TICKET: Record<TicketStatus, StatusTone> = {
  OPEN: "info",
  IN_PROGRESS: "warning",
  RESOLVED: "operational",
  CANCELLED: "neutral",
};

const EVENT: Record<EventStatus, StatusTone> = {
  PLANNED: "info",
  CONFIRMED: "operational",
  IN_PROGRESS: "warning",
  DONE: "neutral",
  CANCELLED: "fault",
};

const PROJECT: Record<ProjectStatus, StatusTone> = {
  REQUESTED: "info",
  CONFIRMED: "operational",
  AWAITING_FEEDBACK: "warning",
  CONSULTATION_SCHEDULED: "info",
  COMPLETED: "operational",
  FOLLOW_UP_REQUIRED: "warning",
  REJECTED: "fault",
  CANCELLED: "neutral",
};

const TASK: Record<TaskStatus, StatusTone> = {
  BACKLOG: "neutral",
  TODO: "info",
  IN_PROGRESS: "warning",
  IN_REVIEW: "info",
  BLOCKED: "fault",
  DONE: "operational",
  CANCELLED: "neutral",
};

const TONES = {
  room: ROOM,
  equipment: EQUIPMENT,
  ticket: TICKET,
  event: EVENT,
  project: PROJECT,
  task: TASK,
} as const;

type StatusKind = keyof typeof TONES;
type StatusValue = {
  room: RoomStatus;
  equipment: EquipmentStatus;
  ticket: TicketStatus;
  event: EventStatus;
  project: ProjectStatus;
  task: TaskStatus;
};

/** Enum value → label in `locale`; an unknown value falls back to its raw text. */
export function statusLabel<K extends StatusKind>(
  locale: Locale,
  kind: K,
  value: StatusValue[K],
): string {
  const key = `status.${kind}.${value}` as MessageKey;
  const label = t(locale, key);
  return label === key ? String(value) : label;
}

export function statusToken<K extends StatusKind>(
  locale: Locale,
  kind: K,
  value: StatusValue[K],
): StatusToken {
  const tone = (TONES[kind] as Record<string, StatusTone>)[value] ?? "neutral";
  return {
    tone,
    label: statusLabel(locale, kind, value),
    className: toneClassName(tone),
    dotClassName: toneDotClassName(tone),
  };
}

/*
 * Label vocabularies the enum speaks to the user. They double as the CSV import
 * grammar: the importers accept the enum value or the label in either language
 * (see `*_ALIASES` below), so a wording change in the catalog changes the grammar.
 * Lives here, not in `app/components/`, because the domain schemas consume it and
 * a domain must not import the components layer.
 */
export const stockStatusLabel = (locale: Locale, value: StockStatus): string =>
  t(locale, `status.stock.${value}`);

export const projectStatusLabel = (locale: Locale, value: ProjectStatus): string =>
  t(locale, `status.project.${value}`);

export const taskStatusLabel = (locale: Locale, value: TaskStatus): string =>
  t(locale, `status.task.${value}`);

export const taskPriorityLabel = (locale: Locale, value: TaskPriority): string =>
  t(locale, `status.taskPriority.${value}`);

export const STOCK_STATUS_ALIASES = enumAliasMap(
  Object.values(StockStatusEnum),
  (v) => `status.stock.${v}` as const,
);

export const TASK_STATUS_ALIASES = enumAliasMap(
  Object.values(TaskStatusEnum),
  (v) => `status.task.${v}` as const,
);

export const TASK_PRIORITY_ALIASES = enumAliasMap(
  Object.values(TaskPriorityEnum),
  (v) => `status.taskPriority.${v}` as const,
);
