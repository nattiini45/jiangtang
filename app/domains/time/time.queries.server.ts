import type { AuditActor } from "~/lib/audit.server";
import { recordTimesheetView, requireTimeAccess } from "./time-access.server";
import { db } from "~/lib/db.server";
import { tr } from "~/i18n/request-locale.server";
import type { TimeEntry } from "~/generated/prisma/client";
import { berlinDayIndex, berlinDayStartMs, isoWeekRange } from "~/lib/berlin-days";
import { splitByBerlinDays, unionMinutes } from "./time-utils";

/**
 * Time-domain queries. Timesheet totals are computed with the UNION of
 * intervals — overlapping entries count once; per-task cells keep the
 * raw per-entry sum and the label says so.
 */

export interface WeekTimesheetRow {
  /** null = entries without a task („Ohne Aufgabe"). */
  taskId: string | null;
  taskTitle: string;
  /** Raw per-task minutes per Berlin day, Mon…Sun. */
  cells: number[];
  /** Raw per-task week sum. */
  total: number;
}

export interface WeekTimesheet {
  isoWeek: string;
  /** "YYYY-MM-DD" per column, Mon…Sun. */
  dayKeys: string[];
  rows: WeekTimesheetRow[];
  /** Union minutes per day (overlaps counted once). */
  dayTotals: number[];
  /** Union minutes over the whole week. */
  weekTotal: number;
  entries: (TimeEntry & { task: { id: string; title: string } | null })[];
}

const ENTRY_INCLUDE = { task: { select: { id: true, title: true } } } as const;

/** The user's running timer, if any (at most one — the partial unique index). */
export async function getRunningEntry(actor: AuditActor, userId = actor.id!) {
  await requireTimeAccess(actor, userId);
  return db.timeEntry.findFirst({ where: { userId, endsAt: null }, include: ENTRY_INCLUDE });
}

export async function getTimeEntry(actor: AuditActor, id: string, userId = actor.id!) {
  await requireTimeAccess(actor, userId);
  return db.timeEntry.findFirst({ where: { id, userId }, include: ENTRY_INCLUDE });
}

/** Entries overlapping the week in either direction, oldest first. */
export async function listWeekEntries(
  actor: AuditActor,
  userId: string,
  isoWeek: string,
  page: { offset?: number; limit?: number } = {},
) {
  await requireTimeAccess(actor, userId);
  const { startDay, endDay } = isoWeekRange(isoWeek);
  const from = new Date(berlinDayStartMs(startDay));
  const to = new Date(berlinDayStartMs(endDay + 1));
  return db.timeEntry.findMany({
    skip: page.offset,
    take: page.limit,
    where: {
      userId,
      startsAt: { lt: to },
      OR: [{ endsAt: null }, { endsAt: { gt: from } }],
    },
    include: ENTRY_INCLUDE,
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
}

/**
 * Rows per task (plus „Ohne Aufgabe") × 7 Berlin days for `isoWeek`.
 * `now` is the effective end of a running timer and is injectable for tests.
 */
export async function getWeekTimesheet(
  actor: AuditActor,
  userId: string,
  isoWeek: string,
  now: Date = new Date(),
): Promise<WeekTimesheet> {
  await requireTimeAccess(actor, userId);
  await recordTimesheetView(actor, userId);
  const { startDay, endDay } = isoWeekRange(isoWeek);
  const weekStart = berlinDayStartMs(startDay);
  const weekEnd = berlinDayStartMs(endDay + 1);
  const dayKeys = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(
      new Date(berlinDayStartMs(startDay + i) + 43_200_000),
    ),
  );

  const entries = await listWeekEntries(actor, userId, isoWeek);
  const effective = entries.map((e) => ({
    entry: e,
    start: e.startsAt.getTime(),
    // A running timer counts up to now, clipped to the week.
    end: Math.min(e.endsAt?.getTime() ?? now.getTime(), weekEnd),
    startClamped: Math.max(e.startsAt.getTime(), weekStart),
  }));

  const rowsByTask = new Map<string | null, WeekTimesheetRow>();
  const dayIntervals: { start: number; end: number }[][] = Array.from({ length: 7 }, () => []);

  for (const { entry, start, end, startClamped } of effective) {
    if (end <= startClamped) continue;
    for (const piece of splitByBerlinDays(new Date(startClamped), new Date(end))) {
      const col = piece.day - startDay;
      if (col < 0 || col > 6) continue;
      const key = entry.taskId ?? null;
      const row =
        rowsByTask.get(key) ??
        (() => {
          const r: WeekTimesheetRow = {
            taskId: key,
            taskTitle: entry.task?.title ?? tr("timesheet.noTask"),
            cells: [0, 0, 0, 0, 0, 0, 0],
            total: 0,
          };
          rowsByTask.set(key, r);
          return r;
        })();
      row.cells[col] += piece.minutes;
      row.total += piece.minutes;

      // The day total merges this day's overlapping pieces: clip the
      // piece back to instants for the union.
      const dayStart = berlinDayStartMs(piece.day);
      const dayEnd = berlinDayStartMs(piece.day + 1);
      dayIntervals[col].push({
        start: Math.max(start, dayStart),
        end: Math.min(end, dayEnd),
      });
    }
  }

  const rows = [...rowsByTask.values()].sort((a, b) => {
    if (a.taskId === null) return 1; // „Ohne Aufgabe" last
    if (b.taskId === null) return -1;
    return a.taskTitle.localeCompare(b.taskTitle, "de");
  });

  return {
    isoWeek,
    dayKeys,
    rows,
    dayTotals: dayIntervals.map(unionMinutes),
    weekTotal: unionMinutes(
      effective
        .filter((e) => e.end > e.startClamped)
        .map((e) => ({ start: e.startClamped, end: e.end })),
    ),
    entries,
  };
}

/** berlinDayIndex re-exported for the route's „heute"-markierung. */
export { berlinDayIndex };
