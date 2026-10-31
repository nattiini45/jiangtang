import type { EventStatus, ServiceWindowKind } from "~/generated/prisma/client";
import { t, type MessageKey } from "~/i18n";
import type { Locale } from "~/i18n/locales";
import { statusLabel } from "~/lib/status";

/** Localized labels for the events domain (client-safe; reused across event views). */

export function eventStatusLabel(locale: Locale, status: EventStatus): string {
  return statusLabel(locale, "event", status);
}

export function serviceWindowKindLabel(locale: Locale, kind: ServiceWindowKind): string {
  return t(locale, `events.serviceWindowKind.${kind}`);
}

/** Calendar-outbox status → label; an unknown status falls back to its raw text. */
export function syncStatusLabel(locale: Locale, status: string): string {
  const key = `events.sync.${status}` as MessageKey;
  const label = t(locale, key);
  return label === key ? status : label;
}

const _everyWindowKindHasLabel: `events.serviceWindowKind.${ServiceWindowKind}` extends MessageKey
  ? true
  : never = true;
