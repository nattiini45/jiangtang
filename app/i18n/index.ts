import { accountDe } from "./catalog/de/account";
import { adminDe } from "./catalog/de/admin";
import { boardDe } from "./catalog/de/board";
import { dashboardDe } from "./catalog/de/dashboard";
import { timesheetDe } from "./catalog/de/timesheet";
import { eventsDe } from "./catalog/de/events";
import { notesDe } from "./catalog/de/notes";
import { projectsDe } from "./catalog/de/projects";
import { ticketsDe } from "./catalog/de/tickets";
import { timelineDe } from "./catalog/de/timeline";
import { authDe } from "./catalog/de/auth";
import { commandDe } from "./catalog/de/command";
import { commonDe } from "./catalog/de/common";
import { errorsDe } from "./catalog/de/errors";
import { errorsPlacesDe } from "./catalog/de/errors-places";
import { errorsWorkDe } from "./catalog/de/errors-work";
import { frequencyDe } from "./catalog/de/frequency";
import { historyDe } from "./catalog/de/history";
import { inventoryDe } from "./catalog/de/inventory";
import { labelsDe } from "./catalog/de/labels";
import { locationsDe } from "./catalog/de/locations";
import { mobileDe } from "./catalog/de/mobile";
import { roomsDe } from "./catalog/de/rooms";
import { searchDe } from "./catalog/de/search";
import { shellDe } from "./catalog/de/shell";
import { statusDe } from "./catalog/de/status";
import { tasksDe } from "./catalog/de/tasks";
import { uploadDe } from "./catalog/de/upload";
import { accountEn } from "./catalog/en/account";
import { adminEn } from "./catalog/en/admin";
import { boardEn } from "./catalog/en/board";
import { dashboardEn } from "./catalog/en/dashboard";
import { timesheetEn } from "./catalog/en/timesheet";
import { eventsEn } from "./catalog/en/events";
import { notesEn } from "./catalog/en/notes";
import { projectsEn } from "./catalog/en/projects";
import { ticketsEn } from "./catalog/en/tickets";
import { timelineEn } from "./catalog/en/timeline";
import { authEn } from "./catalog/en/auth";
import { commandEn } from "./catalog/en/command";
import { commonEn } from "./catalog/en/common";
import { errorsEn } from "./catalog/en/errors";
import { errorsPlacesEn } from "./catalog/en/errors-places";
import { errorsWorkEn } from "./catalog/en/errors-work";
import { frequencyEn } from "./catalog/en/frequency";
import { historyEn } from "./catalog/en/history";
import { inventoryEn } from "./catalog/en/inventory";
import { labelsEn } from "./catalog/en/labels";
import { locationsEn } from "./catalog/en/locations";
import { mobileEn } from "./catalog/en/mobile";
import { roomsEn } from "./catalog/en/rooms";
import { searchEn } from "./catalog/en/search";
import { shellEn } from "./catalog/en/shell";
import { statusEn } from "./catalog/en/status";
import { tasksEn } from "./catalog/en/tasks";
import { uploadEn } from "./catalog/en/upload";
import { FALLBACK_LOCALE, type Locale } from "./locales";

/*
 * One catalog file per area. Each English file is typed against its German
 * twin (`satisfies Record<keyof typeof de, string>`), so a missing or extra key
 * fails `tsc`; the merged objects below keep that guarantee per area.
 */
const de = {
  ...accountDe,
  ...adminDe,
  ...dashboardDe,
  ...timesheetDe,
  ...boardDe,
  ...eventsDe,
  ...notesDe,
  ...projectsDe,
  ...ticketsDe,
  ...timelineDe,
  ...authDe,
  ...commandDe,
  ...commonDe,
  ...errorsDe,
  ...errorsPlacesDe,
  ...errorsWorkDe,
  ...frequencyDe,
  ...historyDe,
  ...inventoryDe,
  ...labelsDe,
  ...locationsDe,
  ...mobileDe,
  ...roomsDe,
  ...searchDe,
  ...shellDe,
  ...statusDe,
  ...tasksDe,
  ...uploadDe,
};
const en = {
  ...accountEn,
  ...adminEn,
  ...dashboardEn,
  ...timesheetEn,
  ...boardEn,
  ...eventsEn,
  ...notesEn,
  ...projectsEn,
  ...ticketsEn,
  ...timelineEn,
  ...authEn,
  ...commandEn,
  ...commonEn,
  ...errorsEn,
  ...errorsPlacesEn,
  ...errorsWorkEn,
  ...frequencyEn,
  ...historyEn,
  ...inventoryEn,
  ...labelsEn,
  ...locationsEn,
  ...mobileEn,
  ...roomsEn,
  ...searchEn,
  ...shellEn,
  ...statusEn,
  ...tasksEn,
  ...uploadEn,
};

export type MessageKey = keyof typeof de;
export type MessageParams = Record<string, string | number>;
export type Translate = (key: MessageKey, params?: MessageParams) => string;

const CATALOGS: Record<Locale, Record<string, string>> = { de, en };

export function messages(locale: Locale): Readonly<Record<MessageKey, string>> {
  return CATALOGS[locale] as Record<MessageKey, string>;
}

function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}

/**
 * Look a message up in `locale`, then in the fallback locale, then return the
 * key itself: a key that slipped past the type checker (dynamic keys) shows up
 * as visible dotted text instead of blanking the UI or throwing.
 */
export function t(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const template = CATALOGS[locale][key] ?? CATALOGS[FALLBACK_LOCALE][key];
  return template === undefined ? key : interpolate(template, params);
}

/**
 * Identity helper for schemas and other client-safe modules: marks a string as
 * a catalog key so it is type-checked now and translated at the edge
 * (`localizeMessage`) once the request locale is known.
 */
export function msgKey(key: MessageKey): string {
  return key;
}

export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(de, value);
}

/** Translate `message` when it is a catalog key; any other text passes through untouched. */
export function localizeMessage(locale: Locale, message: string): string {
  return isMessageKey(message) ? t(locale, message) : message;
}
