/**
 * The demo workspace in the installation's language. `data.ts` is the German
 * set and the single source of structure (ids, relations, offsets, statuses,
 * counts); `data.en.ts` holds only the English wording per stable id. Merging
 * the overlay onto the German rows keeps both sets identical in shape, and a
 * missing overlay entry fails loudly instead of leaving German text behind.
 */
import type { Locale } from "~/i18n/locales";
import {
  INVENTORY,
  LOCATIONS,
  NOTES,
  PROJECTS,
  TASKS,
  TICKETS,
  TIME_ENTRIES,
  VENDORS,
} from "./data";
import {
  EN_INVENTORY,
  EN_LOCATIONS,
  EN_NOTES,
  EN_PROJECTS,
  EN_TASKS,
  EN_TICKETS,
  EN_TIME_ENTRIES,
  EN_VENDORS,
  type Text,
} from "./data.en";

export type SeedData = {
  LOCATIONS: typeof LOCATIONS;
  VENDORS: typeof VENDORS;
  PROJECTS: typeof PROJECTS;
  TASKS: typeof TASKS;
  TICKETS: typeof TICKETS;
  NOTES: typeof NOTES;
  INVENTORY: typeof INVENTORY;
  TIME_ENTRIES: typeof TIME_ENTRIES;
};

function overlay<B extends { id: string }, O extends object>(
  rows: readonly B[],
  texts: Text<O>,
  what: string,
): (B & O)[] {
  const extra = Object.keys(texts).filter((id) => !rows.some((r) => r.id === id));
  if (extra.length > 0) throw new Error(`English seed ${what}: unknown ids ${extra.join(", ")}`);
  return rows.map((row) => {
    const text = texts[row.id];
    if (!text) throw new Error(`English seed ${what}: no text for ${row.id}`);
    return { ...row, ...text };
  });
}

let english: SeedData | undefined;

export function seedDataFor(locale: Locale): SeedData {
  if (locale === "de") {
    return { LOCATIONS, VENDORS, PROJECTS, TASKS, TICKETS, NOTES, INVENTORY, TIME_ENTRIES };
  }
  english ??= {
    LOCATIONS: overlay(LOCATIONS, EN_LOCATIONS, "locations"),
    VENDORS: overlay(VENDORS, EN_VENDORS, "vendors"),
    PROJECTS: overlay(PROJECTS, EN_PROJECTS, "projects"),
    TASKS: overlay(TASKS, EN_TASKS, "tasks"),
    TICKETS: overlay(TICKETS, EN_TICKETS, "tickets"),
    NOTES: overlay(NOTES, EN_NOTES, "notes"),
    INVENTORY: overlay(INVENTORY, EN_INVENTORY, "inventory"),
    TIME_ENTRIES: overlay(TIME_ENTRIES, EN_TIME_ENTRIES, "time entries"),
  };
  return english;
}
