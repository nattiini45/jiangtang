import * as React from "react";
import { Link } from "react-router";
import { statusToken } from "~/lib/status";
import { buttonVariants } from "~/components/ui/button";
import type { EventListRow } from "~/domains/events/events.queries.server";
import type { EventStatus } from "~/generated/prisma/enums";
import { formatDateWith } from "~/i18n/format";
import type { Locale } from "~/i18n/locales";
import { useLocale, useT } from "~/i18n/use-t";
import type { MessageKey, Translate } from "~/i18n";

/**
 * Month-grid calendar over AV events ("event calendar/timeline"). A
 * lightweight hand-rolled grid (no extra dep) keyed off the frozen status colors.
 * Events are bucketed by their Berlin start-day; multi-day events appear on each
 * day they span. Pure/client-safe — works over whatever the loader already
 * fetched, so switching list ⇄ calendar is instant.
 */

function weekdayLabels(t: Translate): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => t(`events.calendar.weekday.${i}` as MessageKey));
}

/** Parse "YYYY-MM" (or default to this month) into a year + 0-based month. */
function parseMonth(input: string | null | undefined): { year: number; month: number } {
  const m = /^(\d{4})-(\d{2})$/.exec(input ?? "");
  if (m) return { year: Number(m[1]), month: Number(m[2]) - 1 };
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

function shiftMonth(year: number, month: number, delta: number): string {
  const d = new Date(year, month + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(locale: Locale, year: number, month: number): string {
  // Noon UTC stays inside the same Berlin calendar day, so the month never shifts.
  return formatDateWith(locale, new Date(Date.UTC(year, month, 1, 12)), {
    month: "long",
    year: "numeric",
  });
}

/** Berlin YYYY-MM-DD for an instant (for bucketing events onto grid days). */
function dayKey(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
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
  const { year, month: m } = parseMonth(month);
  const prev = shiftMonth(year, m, -1);
  const next = shiftMonth(year, m, +1);

  // Build the grid: first cell is Monday of the week containing day 1.
  const firstOfMonth = new Date(year, m, 1);
  // JS getDay: 0=Sun..6=Sat → convert to 0=Mon..6=Sun
  const lead = (firstOfMonth.getDay() + 6) % 7;
  const daysInMonth = new Date(year, m + 1, 0).getDate();

  const cells: Array<{ day: number | null; date: string | null }> = [];
  for (let i = 0; i < lead; i++) cells.push({ day: null, date: null });
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, m, d);
    cells.push({ day: d, date: dayKey(date) });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, date: null });

  // Bucket events by each day they span (Berlin wall-clock), half-open
  // [startsAt, endsAt) — same semantics as the booking overlap invariant. The
  // last occupied instant is endsAt minus 1ms: an event ending exactly at
  // Berlin midnight on day D+1 occupies through day D only, so bucketing off
  // `endsAt` directly would render a phantom chip on D+1. All comparisons stay
  // in terms of Berlin dayKey strings (not raw Date arithmetic, which is in
  // the machine's local timezone and would drift from Berlin day boundaries).
  const byDay = new Map<string, EventListRow[]>();
  for (const ev of events) {
    const startKey = dayKey(ev.startsAt);
    const lastOccupied = new Date(new Date(ev.endsAt).getTime() - 1);
    const lastKey = dayKey(lastOccupied);
    // `lastKey <= startKey` (not just `===`) covers same-day AND any degenerate
    // non-positive-duration row (endsAt <= startsAt, where lastKey lands BEFORE
    // startKey). Such a row must never enter the forward-walking multi-day branch
    // below, which only breaks on `key === lastKey` and would otherwise spin
    // forever (pinning a CPU core during SSR). The write path forbids this via
    // the Zod `startsAt < endsAt` refine; this guards imported/legacy/raw rows.
    if (lastKey <= startKey) {
      const arr = byDay.get(startKey) ?? [];
      arr.push(ev);
      byDay.set(startKey, arr);
    } else {
      // multi-day: walk each Berlin calendar day from start through lastKey
      // (inclusive) by stepping the instant forward 24h and re-deriving its
      // Berlin dayKey each time — robust to the machine's local timezone/DST.
      let cursor = new Date(ev.startsAt);
      let key = startKey;
      while (true) {
        const arr = byDay.get(key) ?? [];
        arr.push(ev);
        byDay.set(key, arr);
        if (key === lastKey) break;
        cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
        key = dayKey(cursor);
      }
    }
  }

  const todayKey = dayKey(new Date());

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
