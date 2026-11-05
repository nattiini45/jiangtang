import * as React from "react";
import { Link } from "react-router";
import { berlinDateKey } from "~/lib/berlin-days";
import { statusToken } from "~/lib/status";
import { buttonVariants } from "~/components/ui/button";
import type { EventListRow } from "~/domains/events/events.queries.server";
import type { EventStatus } from "~/generated/prisma/enums";
import { formatDateWith } from "~/i18n/format";
import type { Locale } from "~/i18n/locales";
import { useLocale, useT } from "~/i18n/use-t";
import {
  bucketEventsByBerlinDay,
  buildMonthCells,
  parseCalendarMonth,
  shiftCalendarMonth,
} from "./event-calendar-days";
import type { MessageKey, Translate } from "~/i18n";

/**
 * Month-grid calendar over AV events ("event calendar/timeline"). A
 * lightweight hand-rolled grid (no extra dep) keyed off the frozen status colors.
 * Multi-day events appear on each Berlin day they span (see event-calendar-days).
 * Pure/client-safe — works over whatever the loader already fetched, so switching
 * list ⇄ calendar is instant.
 */

function weekdayLabels(t: Translate): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => t(`events.calendar.weekday.${i}` as MessageKey));
}

function monthLabel(locale: Locale, year: number, month: number): string {
  // Noon UTC stays inside the same Berlin calendar day, so the month never shifts.
  return formatDateWith(locale, new Date(Date.UTC(year, month, 1, 12)), {
    month: "long",
    year: "numeric",
  });
}

export function EventCalendar({
  events,
  month,
}: {
  events: EventListRow[];
  month: string | null | undefined;
}) {
  const locale = useLocale();
  const t = useT();
  const weekdays = weekdayLabels(t);
  const { year, month: m } = parseCalendarMonth(month);
  const prev = shiftCalendarMonth(year, m, -1);
  const next = shiftCalendarMonth(year, m, +1);

  const cells = buildMonthCells(year, m);
  const byDay = bucketEventsByBerlinDay(events, year, m);

  const todayKey = berlinDateKey(new Date());

  return (
    <div className="bg-card shadow-surface-2 flex flex-col overflow-hidden rounded-lg">
      <div className="border-border flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-base font-semibold">{monthLabel(locale, year, m)}</h2>
        <div className="flex items-center gap-1">
          <Link
            to={`?view=calendar&month=${prev}`}
            className={buttonVariants({ variant: "tertiary", size: "compact" })}
          >
            ←
          </Link>
          <Link
            to={`?view=calendar&month=${next}`}
            className={buttonVariants({ variant: "tertiary", size: "compact" })}
          >
            →
          </Link>
        </div>
      </div>

      {/* The Sunday column closes the card, so it drops its right hairline. */}
      <div className="grid grid-cols-7 [&>:nth-child(7n)]:border-r-0">
        {weekdays.map((w) => (
          <div
            key={w}
            className="text-muted-foreground border-border border-r border-b px-2 py-1 text-xs"
          >
            {w}
          </div>
        ))}
        {cells.map((cell, i) => {
          const dayEvents = cell.date ? (byDay.get(cell.date) ?? []) : [];
          const isToday = cell.date === todayKey;
          return (
            <div
              key={i}
              className={[
                "border-border min-h-[96px] border-r border-b p-1.5",
                cell.day === null ? "bg-tint" : "",
              ].join(" ")}
            >
              {cell.day !== null ? (
                <div
                  aria-current={isToday ? "date" : undefined}
                  className={[
                    "nums mb-1 flex items-center gap-1.5 text-xs",
                    isToday ? "text-foreground font-semibold" : "text-muted-foreground",
                  ].join(" ")}
                >
                  {cell.day}
                  {isToday ? (
                    <span aria-hidden className="bg-foreground size-1 rounded-full" />
                  ) : null}
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                {dayEvents.map((ev) => (
                  <CalendarChip key={ev.id} ev={ev} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalendarChip({ ev }: { ev: EventListRow }) {
  const locale = useLocale();
  const token = statusToken(locale, "event", ev.status as EventStatus);
  const time = formatDateWith(locale, ev.startsAt, { hour: "2-digit", minute: "2-digit" });
  return (
    <Link
      to={`/events/${ev.id}`}
      title={ev.title}
      className={["block truncate rounded-sm px-1.5 py-0.5 text-xs", token.className].join(" ")}
    >
      <span className="nums">{time}</span> {ev.title}
    </Link>
  );
}
