import * as React from "react";
import { Form, Link, redirect, useLocation, useNavigation } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listEvents } from "~/domains/events/events.queries.server";
import { getCalendarData } from "~/domains/events/events.calendar.queries.server";
import { EventStatus } from "~/generated/prisma/enums";
import { parseEnumParam } from "~/lib/validation.server";
import {
  CALENDAR_VIEWS,
  calendarRange,
  calendarSlotHref,
  parseCalendarDate,
  shiftCalendarDate,
  type CalendarView,
} from "~/lib/event-calendar";
import { berlinDayIndex, berlinDayStartMs, dayIndexToDateKey } from "~/lib/berlin-days";
import { DataGrid } from "~/components/data-grid";
import { eventColumns } from "~/components/events/event-columns";
import {
  CalendarMonth,
  CalendarTimeGrid,
  RoomsTimeline,
} from "~/components/events/booking-calendar";
import { CalendarSubscribe } from "~/components/events/calendar-subscribe";
import { eventStatusLabel } from "~/components/events/labels";
import { Button, buttonVariants } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { Input } from "~/components/ui/input";
import { Checkbox } from "~/components/ui/checkbox";
import { t } from "~/i18n";
import { formatDateWith } from "~/i18n/format";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "events.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const params = url.searchParams;
  const status = parseEnumParam(EventStatus, params.get("status"));
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
    throw redirect(`/events?${params}`);
  }
  const range = calendarRange(day, view);
  const roomId = params.get("room") ?? "";
  const equipmentId = params.get("equipment") ?? "";
  const showTasks = params.get("tasks") === "1";
  const [calendar, list] = await Promise.all([
    view === "list"
      ? Promise.resolve({ events: [], bookings: [], rooms: [], equipment: [], tasks: [] })
      : getCalendarData({
          from: range.from,
          to: range.to,
          roomId: roomId || undefined,
          equipmentId: equipmentId || undefined,
          status,
          includeTasks: showTasks,
        }),
    view === "list" ? listEvents({ status }) : Promise.resolve([]),
  ]);
  const feedToken = process.env.ICAL_FEED_TOKEN;
  const feedUrl =
    user.role === "ADMIN" && feedToken
      ? `${url.protocol}//${url.host}/calendar/${feedToken}/ics`
      : null;
  return {
    calendar,
    list,
    view,
    date,
    day,
    startDay: range.startDay,
    endDay: range.endDay,
    filters: { status: status ?? "", roomId, equipmentId, showTasks },
    feedUrl,
  };
}

export default function EventsIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const location = useLocation();
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  const { calendar, list, view, date, day, startDay, endDay, filters, feedUrl } = loaderData;
  const currentLocation =
    navigation.location?.pathname === location.pathname ? navigation.location : location;
  const currentParams = new URLSearchParams(currentLocation.search);
  const rawView = currentParams.get("view");
  const currentView = CALENDAR_VIEWS.includes(rawView as CalendarView)
    ? (rawView as CalendarView)
    : view;
  const currentDate = currentParams.get("date") ?? date;
  const currentDay = parseCalendarDate(currentDate);
  const currentFilters = {
    status: currentParams.get("status") ?? "",
    roomId: currentParams.get("room") ?? "",
    equipmentId: currentParams.get("equipment") ?? "",
    showTasks: currentParams.get("tasks") === "1",
  };
  const columns = React.useMemo(() => eventColumns(t), [t]);
  const href = (changes: Record<string, string>) => {
    const params = new URLSearchParams({
      view: currentView,
      date: currentDate,
      status: currentFilters.status,
      room: currentFilters.roomId,
      equipment: currentFilters.equipmentId,
      tasks: currentFilters.showTasks ? "1" : "",
      ...changes,
    });
    for (const [key, value] of [...params]) if (!value) params.delete(key);
    return `?${params}`;
  };
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
    <div className="flex min-w-0 flex-col gap-5" aria-busy={pending}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("events.list.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("events.list.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          {feedUrl ? <CalendarSubscribe url={feedUrl} /> : null}
          <Button asChild>
            <Link to={calendarSlotHref(day)}>{t("events.list.new")}</Link>
          </Button>
        </div>
      </div>
      <nav aria-label={t("events.calendar.views")} className="flex flex-wrap items-center gap-1">
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Link
              to={href({ date: dayIndexToDateKey(shiftCalendarDate(currentDay, currentView, -1)) })}
              aria-label={t("events.calendar.previous")}
              className={buttonVariants({ variant: "tertiary", size: "icon-compact" })}
            >
              <ChevronLeft className="size-4" aria-hidden />
            </Link>
            <Link
              to={href({ date: dayIndexToDateKey(shiftCalendarDate(currentDay, currentView, 1)) })}
              aria-label={t("events.calendar.next")}
              className={buttonVariants({ variant: "tertiary", size: "icon-compact" })}
            >
              <ChevronRight className="size-4" aria-hidden />
            </Link>
            <Link
              to={href({ date: dayIndexToDateKey(berlinDayIndex(new Date())) })}
              className={buttonVariants({ variant: "tertiary", size: "compact" })}
            >
              {t("events.calendar.today")}
            </Link>
          </div>
          <h2
            className={
              view !== "list" &&
              view !== "week" &&
              view !== "month" &&
              day === berlinDayIndex(new Date())
                ? "bg-selected rounded-md px-2 py-1 text-base font-semibold"
                : "text-base font-semibold"
            }
            aria-live="polite"
            aria-current={
              (view === "day" || view === "rooms") && day === berlinDayIndex(new Date())
                ? "date"
                : undefined
            }
          >
            {view === "list" ? t("events.calendar.allEvents") : period}
          </h2>
        </div>
        <p className="text-muted-foreground text-xs">Europe/Berlin</p>
      </div>
      <Form
        key={href({})}
        method="get"
        className="flex flex-wrap items-center gap-2"
        onChange={(event) => event.currentTarget.requestSubmit()}
      >
        <input type="hidden" name="view" value={currentView} />
        <Input
          type="date"
          name="date"
          defaultValue={currentDate}
          aria-label={t("events.calendar.date")}
          className="w-40"
          min="1900-01-01"
          max="2100-12-31"
        />
        {view !== "rooms" ? (
          <Select
            name="status"
            aria-label={t("events.list.filterStatus")}
            defaultValue={currentFilters.status}
            className="w-40"
          >
            <option value="">{t("events.list.allStatuses")}</option>
            {Object.values(EventStatus).map((s) => (
              <option key={s} value={s}>
                {eventStatusLabel(locale, s)}
              </option>
            ))}
          </Select>
        ) : (
          <input type="hidden" name="status" value={currentFilters.status} />
        )}
        {view !== "list" ? (
          <>
            <Select
              name="room"
              aria-label={t("events.calendar.filterRoom")}
              defaultValue={currentFilters.roomId}
              className="max-w-52"
            >
              <option value="">{t("events.calendar.allRooms")}</option>
              {calendar.rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </Select>
            {view !== "rooms" ? (
              <Select
                name="equipment"
                aria-label={t("events.calendar.filterEquipment")}
                defaultValue={currentFilters.equipmentId}
                className="max-w-52"
              >
                <option value="">{t("events.calendar.allEquipment")}</option>
                {calendar.equipment.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </Select>
            ) : (
              <input type="hidden" name="equipment" value={currentFilters.equipmentId} />
            )}
            <label className="flex h-control cursor-pointer items-center gap-2 px-1 text-sm">
              <Checkbox
                name="tasks"
                value="1"
                defaultChecked={currentFilters.showTasks}
                aria-label={t("events.calendar.showTasks")}
              />
              {t("events.calendar.tasks")}
            </label>
          </>
        ) : (
          <>
            <input type="hidden" name="room" value={currentFilters.roomId} />
            <input type="hidden" name="equipment" value={currentFilters.equipmentId} />
            <input type="hidden" name="tasks" value={currentFilters.showTasks ? "1" : ""} />
          </>
        )}
        <noscript>
          <Button type="submit" variant="tertiary" size="compact">
            {t("events.list.filterSubmit")}
          </Button>
        </noscript>
      </Form>
      {view !== "list" &&
      calendar.events.length === 0 &&
      (view !== "rooms" || calendar.bookings.length === 0) ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t("events.calendar.empty")}
        </p>
      ) : null}
      {view === "month" ? (
        <CalendarMonth
          {...calendar}
          startDay={startDay}
          endDay={endDay}
          selectedDay={day}
          dayHref={(selected) => href({ view: "day", date: dayIndexToDateKey(selected) })}
        />
      ) : view === "rooms" ? (
        <>
          {filters.showTasks ? (
            <div className="flex flex-wrap gap-2">
              {calendar.tasks.map((task) => (
                <Link
                  key={task.id}
                  to={`/tasks/${task.id}`}
                  className="bg-tint hover:bg-selected rounded-md px-2 py-1 text-sm"
                >
                  {t("events.calendar.taskDue", { title: task.title })}
                </Link>
              ))}
            </div>
          ) : null}
          <RoomsTimeline
            rooms={calendar.rooms.filter((room) => !filters.roomId || room.id === filters.roomId)}
            bookings={calendar.bookings}
            day={day}
          />
        </>
      ) : view === "list" ? (
        <DataGrid
          columns={columns}
          data={list}
          getRowId={(event) => event.id}
          emptyMessage={t("events.list.empty")}
          maxHeight={640}
        />
      ) : (
        <CalendarTimeGrid
          {...calendar}
          startDay={startDay}
          endDay={endDay}
          dayHref={(selected) => href({ view: "day", date: dayIndexToDateKey(selected) })}
        />
      )}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
