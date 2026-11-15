import { Link, redirect, useLocation, useNavigation } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { readConfig } from "~/lib/config.server";
import { getWorkspaceCalendar, calendarChoices } from "~/domains/calendar/calendar.queries.server";
import { calendarKinds } from "~/lib/calendar-entries";
import {
  CALENDAR_VIEWS,
  calendarRange,
  calendarSlotHref,
  parseCalendarDate,
  shiftCalendarDate,
  type CalendarView,
} from "~/lib/event-calendar";
import { berlinDayIndex, berlinDayStartMs, dayIndexToDateKey } from "~/lib/berlin-days";
import {
  CalendarMonth,
  CalendarTimeGrid,
  RoomsTimeline,
} from "~/components/events/booking-calendar";
import { CalendarFilters } from "~/components/events/calendar-filters";
import { CalendarSubscribe } from "~/components/events/calendar-subscribe";
import { EventStatus } from "~/generated/prisma/enums";
import { parseEnumParam } from "~/lib/validation.server";
import { Button, buttonVariants } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { formatDateWith, formatTime } from "~/i18n/format";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "calendar.meta") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const params = url.searchParams;
  const rawView = params.get("view");
  const view: CalendarView = CALENDAR_VIEWS.includes(rawView as CalendarView)
    ? (rawView as CalendarView)
    : rawView === "calendar"
      ? "month"
      : "week";
  const day = parseCalendarDate(
    params.get("date") ?? (params.get("month") ? `${params.get("month")}-01` : null),
  );
  const date = dayIndexToDateKey(day);
  if (params.get("date") !== date || rawView !== view) {
    params.set("date", date);
    params.set("view", view);
    params.delete("month");
    throw redirect(`/calendar?${params}`);
  }
  const range = calendarRange(day, view);
  const calendar = await getWorkspaceCalendar({
    from: range.from,
    to: range.to,
    kinds: calendarKinds(params, calendarChoices),
    roomId: params.get("room") || undefined,
    equipmentId: params.get("equipment") || undefined,
    status: parseEnumParam(EventStatus, params.get("status")),
  });
  const token = readConfig("ICAL_FEED_TOKEN");
  return {
    calendar,
    choices: calendarChoices,
    view,
    date,
    day,
    startDay: range.startDay,
    endDay: range.endDay,
    feedUrl:
      user.role === "ADMIN" && token ? `${url.protocol}//${url.host}/calendar/${token}/ics` : null,
  };
}

export default function Calendar({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const location = useLocation();
  const navigation = useNavigation();
  const { calendar, choices, view, day, startDay, endDay, feedUrl } = loaderData;
  const current =
    navigation.location?.pathname === location.pathname ? navigation.location : location;
  const params = new URLSearchParams(current.search);
  const currentView = (params.get("view") ?? view) as CalendarView;
  const currentDay = parseCalendarDate(params.get("date"));
  const href = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) next.set(key, value);
    return `?${next}`;
  };
  const dayHref = (selected: number) => href({ view: "day", date: dayIndexToDateKey(selected) });
  const period =
    view === "month"
      ? formatDateWith(locale, berlinDayStartMs(day), { month: "long", year: "numeric" })
      : view === "week"
        ? `${formatDateWith(locale, berlinDayStartMs(startDay), { day: "numeric", month: "short" })} – ${formatDateWith(locale, berlinDayStartMs(endDay - 1), { day: "numeric", month: "short", year: "numeric" })}`
        : formatDateWith(locale, berlinDayStartMs(day), {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          });
  return (
    <div className="flex min-w-0 flex-col gap-4" aria-busy={navigation.state !== "idle"}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{t("nav.calendar")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{t("calendar.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {feedUrl ? <CalendarSubscribe url={feedUrl} /> : null}
          <Button asChild>
            <Link to={calendarSlotHref(day)}>{t("events.list.new")}</Link>
          </Button>
        </div>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label={t("events.calendar.views")} className="flex flex-wrap gap-1">
          {CALENDAR_VIEWS.map((option) => (
            <Link
              key={option}
              to={href({ view: option })}
              aria-current={view === option ? "page" : undefined}
              className={buttonVariants({
                variant: view === option ? "secondary" : "ghost",
                size: "compact",
              })}
            >
              {t(`events.calendar.view.${option}`)}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-1">
          {([-1, 1] as const).map((delta) => (
            <Link
              key={delta}
              to={href({
                date: dayIndexToDateKey(shiftCalendarDate(currentDay, currentView, delta)),
              })}
              aria-label={t(delta < 0 ? "events.calendar.previous" : "events.calendar.next")}
              className={buttonVariants({ variant: "tertiary", size: "icon-compact" })}
            >
              {delta < 0 ? (
                <ChevronLeft className="size-4" aria-hidden />
              ) : (
                <ChevronRight className="size-4" aria-hidden />
              )}
            </Link>
          ))}
          <Link
            to={href({ date: dayIndexToDateKey(berlinDayIndex(new Date())) })}
            className={buttonVariants({ variant: "tertiary", size: "compact" })}
          >
            {t("events.calendar.today")}
          </Link>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold" aria-live="polite">
          {period}
        </h2>
        <span className="text-muted-foreground text-xs">Europe/Berlin</span>
      </div>
      <CalendarFilters
        params={params}
        choices={choices}
        rooms={calendar.rooms}
        equipment={calendar.equipment}
      />
      {params.get("room") || params.get("equipment") ? (
        <p className="text-muted-foreground text-xs">{t("calendar.resourceHint")}</p>
      ) : null}
      {!calendar.entries.length ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t("calendar.empty")}
        </p>
      ) : null}
      {view === "month" ? (
        <CalendarMonth
          entries={calendar.entries}
          startDay={startDay}
          endDay={endDay}
          selectedDay={day}
          dayHref={dayHref}
        />
      ) : view === "rooms" ? (
        <>
          <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto">
            {calendar.entries.map((entry) => (
              <Link
                key={entry.id}
                to={entry.href}
                className="bg-tint hover:bg-selected max-w-72 rounded-md px-2 py-1 text-sm"
              >
                <span className="text-muted-foreground text-xs">
                  {t(entry.kind)} ·{" "}
                  {entry.allDay
                    ? t("calendar.wholeDay")
                    : entry.point
                      ? formatTime(locale, entry.startsAt)
                      : `${formatTime(locale, entry.startsAt)}–${formatTime(locale, entry.endsAt)}`}
                </span>
                <span className="line-clamp-2 wrap-anywhere">{entry.title}</span>
              </Link>
            ))}
          </div>
          <RoomsTimeline
            rooms={calendar.rooms.filter(
              (room) => !params.get("room") || room.id === params.get("room"),
            )}
            bookings={calendar.bookings}
            day={day}
          />
        </>
      ) : (
        <CalendarTimeGrid
          entries={calendar.entries}
          startDay={startDay}
          endDay={endDay}
          dayHref={dayHref}
        />
      )}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
