import type { TicketStatus, TicketType } from "~/generated/prisma/client";
import { t, type MessageKey } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import { statusLabel } from "~/lib/status";

/** Localized labels for the ticket enums and numeric priority (client-safe; reused across ticket views). */

export function ticketTypeLabel(locale: Locale, type: TicketType): string {
  return t(locale, `search.ticketType.${type}`);
}

export function ticketStatusLabel(locale: Locale, status: TicketStatus): string {
  return statusLabel(locale, "ticket", status);
}

/** Numeric priority (1–3) → label; an unknown number falls back to its raw text. */
export function priorityLabel(locale: Locale, priority: number): string {
  const key = `tickets.priority.${priority}` as MessageKey;
  const label = t(locale, key);
  return label === key ? String(priority) : label;
}

export interface PriorityOption {
  value: number;
  label: string;
}

export function priorityOptions(locale: Locale): PriorityOption[] {
  return [1, 2, 3].map((value) => ({ value, label: `${value} · ${priorityLabel(locale, value)}` }));
}

const _everyTypeHasLabel: `search.ticketType.${TicketType}` extends MessageKey ? true : never =
  true;
