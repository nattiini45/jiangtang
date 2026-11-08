import * as React from "react";
import { Link } from "react-router";
import { CalendarCheck, MoveHorizontal, Plus } from "lucide-react";
import type {
  CalendarBooking,
  CalendarEvent,
  CalendarTask,
} from "~/domains/events/events.calendar.queries.server";
import {
  berlinDayIndex,
  berlinDayStartMs,
  berlinLocalString,
  civilFromDayIndex,
  dayIndexToDateKey,
} from "~/lib/berlin-days";
import {
  calendarDays,
  calendarSlotHref,
  dayHours,
  eventsOnDay,
  instantSlotHref,
} from "~/lib/event-calendar";
import { formatDateWith, formatTime } from "~/i18n/format";
import { useLocale, useT } from "~/i18n/use-t";
import { statusToken } from "~/lib/status";
import { cn } from "~/lib/utils";

type Data = {
  events: CalendarEvent[];
  tasks: CalendarTask[];
  startDay: number;
  endDay: number;
  dayHref: (day: number) => string;
};

function navigateSlots(event: React.KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target as HTMLElement;
  const slot = target.closest<HTMLAnchorElement>("a[data-slot-row]");
  if (
    !slot ||
    !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  )
    return;
  const row = Number(slot.dataset.slotRow);
  const column = Number(slot.dataset.slotColumn);
  const slots = Array.from(
    event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-slot-row]"),
  );
  const horizontal = event.currentTarget.dataset.slotOrientation === "horizontal";
  const sideways = event.key === "ArrowLeft" || event.key === "ArrowRight";
  let next: HTMLAnchorElement | undefined;
  if (event.key === "Home" || event.key === "End") {
    const candidates = slots.filter((candidate) =>
      horizontal
        ? Number(candidate.dataset.slotRow) === row
        : Number(candidate.dataset.slotColumn) === column,
    );
    next = event.key === "Home" ? candidates[0] : candidates.at(-1);
  } else if (sideways && !horizontal) {
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const candidates = slots.filter(
      (candidate) => Number(candidate.dataset.slotColumn) === column + direction,
    );
    const time = Number(slot.dataset.slotTime);
    candidates.sort(
      (a, b) =>
        Math.abs(Number(a.dataset.slotTime) - time) - Math.abs(Number(b.dataset.slotTime) - time) ||
        Math.abs(Number(a.dataset.slotRow) - row) - Math.abs(Number(b.dataset.slotRow) - row),
    );
    next = candidates[0];
  } else {
    const direction = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 1;
    const coordinate = sideways ? "slotColumn" : "slotRow";
    const fixed = sideways ? "slotRow" : "slotColumn";
    const current = sideways ? column : row;
    const candidates = slots.filter(
      (candidate) =>
        Number(candidate.dataset[fixed]) === (sideways ? row : column) &&
        (Number(candidate.dataset[coordinate]) - current) * direction > 0,
    );
    candidates.sort(
      (a, b) =>
        Math.abs(Number(a.dataset[coordinate]) - current) -
        Math.abs(Number(b.dataset[coordinate]) - current),
    );
    next = candidates[0];
  }
  event.preventDefault();
  if (next) {
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function TaskMarkers({
  tasks,
  day,
  limit,
  compact = false,
}: {
  tasks: CalendarTask[];
  day: number;
  limit?: number;
  compact?: boolean;
}) {
  const t = useT();
  const due = tasks.filter((task) => berlinDayIndex(new Date(task.dueAt)) === day);
  return due.slice(0, limit).map((task) => (
    <Link
      key={task.id}
      to={`/tasks/${task.id}`}
      className="hover:bg-hover relative z-10 flex min-h-7 min-w-0 items-start gap-1 rounded-sm px-1 py-1 text-xs"
      title={t("events.calendar.taskDue", { title: task.title })}
    >
      <CalendarCheck className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span
        className={cn(
          "min-w-0",
          compact ? "line-clamp-3 wrap-break-word hyphens-auto" : "line-clamp-2 wrap-anywhere",
        )}
      >
        {task.title}
      </span>
    </Link>
  ));
}

function EventLabel({
  event,
  compact = false,
  dense = false,
  short = false,
  narrow = false,
  height = Infinity,
}: {
  event: CalendarEvent;
  compact?: boolean;
  dense?: boolean;
  short?: boolean;
  narrow?: boolean;
  height?: number;
}) {
  const locale = useLocale();
  const token = statusToken(locale, "event", event.status);
  const time = (value: Date) => {
    const instant = +new Date(value);
    const hour = berlinLocalString(instant).slice(0, 13);
    const repeated = [instant - 3_600_000, instant + 3_600_000].some(
      (other) => berlinLocalString(other).slice(0, 13) === hour,
    );
    return repeated
      ? formatDateWith(locale, value, {
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
          hourCycle: "h23",
        })
      : formatTime(locale, value);
  };
  const resources = [
    ...event.rooms.map((room) => room.name),
    ...event.equipment.map((item) => item.name),
  ].join(" · ");
  if (narrow && height < 76)
    return (
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            "wrap-anywhere text-xs font-semibold",
            height < 44 ? "line-clamp-1" : height < 60 ? "line-clamp-2" : "line-clamp-3",
            event.status === "CANCELLED" && "line-through",
          )}
        >
          {event.title}
        </span>
        <span className="sr-only">
          {time(event.startsAt)}–{time(event.endsAt)} {token.label} {resources}
        </span>
      </span>
    );
  if (short)
    return (
      <span className="flex min-w-0 items-center gap-1 text-xs">
        <span className={cn("size-1.5 shrink-0 rounded-full", token.dotClassName)} aria-hidden />
        <span
          className={cn("truncate font-semibold", event.status === "CANCELLED" && "line-through")}
        >
          {time(event.startsAt)} {event.title}
        </span>
        <span className="sr-only">
          {token.label} {resources}
        </span>
      </span>
    );
  return (
    <>
      <span className="flex items-center gap-1 text-xs">
        <span className={cn("size-1.5 shrink-0 rounded-full", token.dotClassName)} aria-hidden />
        <span className="nums truncate">
          {time(event.startsAt)}
          {compact || narrow ? "" : `–${time(event.endsAt)}`}
        </span>
        <span className="sr-only">{token.label}</span>
      </span>
      <span
        title={event.title}
        className={cn(
          "min-w-0 text-xs font-semibold",
          dense && !(narrow && height >= 92) ? "line-clamp-2" : "line-clamp-3",
          compact ? "wrap-break-word hyphens-auto" : "wrap-anywhere",
          event.status === "CANCELLED" && "line-through",
        )}
      >
        {event.title}
      </span>
      {!compact && resources ? (
        <span
          title={resources}
          className={cn(
            "text-muted-foreground min-w-0 wrap-anywhere text-xs",
            dense ? "line-clamp-1" : "line-clamp-2",
          )}
        >
          {resources}
        </span>
      ) : null}
    </>
  );
}

export function CalendarMonth({
  events,
  tasks,
  startDay,
  endDay,
  selectedDay,
  dayHref,
}: Data & { selectedDay: number }) {
  const locale = useLocale();
  const t = useT();
  const today = berlinDayIndex(new Date());
  const month = civilFromDayIndex(selectedDay).month;
  return (
    <div className="bg-card shadow-surface-2 overflow-x-auto rounded-lg">
      <div className="grid min-w-[700px] grid-cols-7">
        {calendarDays(startDay, startDay + 7).map((day) => (
          <div key={day} className="text-muted-foreground border-border border-b px-3 py-2 text-xs">
            {formatDateWith(locale, berlinDayStartMs(day), { weekday: "short" })}
          </div>
        ))}
        {calendarDays(startDay, endDay).map((day) => {
          const dayEvents = eventsOnDay(events, day);
          const dayTasks = tasks.filter((task) => berlinDayIndex(new Date(task.dueAt)) === day);
          const hidden = Math.max(0, dayEvents.length - 2) + Math.max(0, dayTasks.length - 2);
          return (
            <section
              key={day}
              aria-label={dayIndexToDateKey(day)}
              className={cn(
                "group/month border-border relative isolate min-h-36 min-w-0 border-r border-b p-2",
                civilFromDayIndex(day).month !== month && "bg-tint/50",
              )}
            >
              <Link
                to={calendarSlotHref(day)}
                aria-label={t("events.calendar.createOn", { date: dayIndexToDateKey(day) })}
                className="group/month-create hover:bg-hover text-muted-foreground absolute inset-0"
              >
                <Plus
                  className="absolute top-3 right-3 size-4 opacity-0 group-hover/month:opacity-100 group-focus-visible/month-create:opacity-100"
                  aria-hidden
                />
              </Link>
              <div className="mb-2 flex items-center justify-between gap-1">
                <Link
                  to={dayHref(day)}
                  aria-current={day === today ? "date" : undefined}
                  className={cn(
                    "hover:bg-hover nums relative z-10 flex size-7 items-center justify-center rounded-md text-sm",
                    day === today && "bg-selected font-semibold",
                  )}
                >
                  {civilFromDayIndex(day).day}
                </Link>
              </div>
              <TaskMarkers tasks={dayTasks} day={day} limit={2} compact />
              <div className="flex flex-col gap-1">
                {dayEvents.slice(0, 2).map((event) => (
                  <Link
                    key={event.id}
                    to={`/events/${event.id}`}
                    title={event.title}
                    className="group bg-card relative z-10 isolate flex min-w-0 flex-col gap-0.5 rounded-md p-1.5"
                  >
                    <span
                      aria-hidden
                      className="bg-tint group-hover:bg-tint-hover pointer-events-none absolute inset-0 -z-10 rounded-[inherit]"
                    />
                    <EventLabel event={event} compact />
                  </Link>
                ))}
                {hidden > 0 ? (
                  <Link
                    to={dayHref(day)}
                    className="hover:bg-hover text-muted-foreground relative z-10 rounded-sm px-1 py-1 text-xs"
                  >
                    {t("events.calendar.more", { count: hidden })}
                  </Link>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function arrangeEvents(events: CalendarEvent[], day: number) {
  const start = berlinDayStartMs(day);
  const end = berlinDayStartMs(day + 1);
  const items = eventsOnDay(events, day).map((event) => ({
    event,
    start: Math.max(+new Date(event.startsAt), start),
    end: Math.min(+new Date(event.endsAt), end),
    lane: 0,
    lanes: 1,
  }));
  items.sort((a, b) => a.start - b.start || b.end - a.end || a.event.id.localeCompare(b.event.id));
  let group: typeof items = [];
  let lanes: number[] = [];
  const finish = () => {
    for (const item of group) item.lanes = lanes.length;
  };
  for (const item of items) {
    if (lanes.every((laneEnd) => laneEnd <= item.start)) {
      finish();
      group = [];
      lanes = [];
    }
    const free = lanes.findIndex((laneEnd) => laneEnd <= item.start);
    item.lane = free === -1 ? lanes.length : free;
    lanes[item.lane] = Math.max(item.end, item.start + 2_250_000);
    group.push(item);
  }
  finish();
  return items;
}

export function CalendarTimeGrid({ events, tasks, startDay, endDay, dayHref }: Data) {
  const locale = useLocale();
  const t = useT();
  const ref = React.useRef<HTMLDivElement>(null);
  const today = berlinDayIndex(new Date());
  const days = calendarDays(startDay, endDay);
  const hasTasks = tasks.some((task) => {
    const day = berlinDayIndex(new Date(task.dueAt));
    return day >= startDay && day < endDay;
  });
  React.useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 7 * 48;
  }, [startDay, endDay]);
  return (
    <div className="bg-card shadow-surface-2 overflow-hidden rounded-lg">
      <p className="text-muted-foreground border-border border-b px-3 py-2 text-xs">
        {t("events.calendar.slotHint")}
      </p>
      <div
        ref={ref}
        className={cn(
          "max-h-[680px] scroll-pb-2 overflow-auto",
          hasTasks ? "scroll-pt-36" : "scroll-pt-14",
        )}
        data-slot-orientation="vertical"
        onKeyDown={navigateSlots}
      >
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${days.length}, minmax(${days.length === 1 ? "260" : "132"}px, 1fr))`,
            gridTemplateRows: "auto 1fr",
          }}
        >
          {days.map((day) => (
            <div
              key={day}
              className="bg-card border-border sticky top-0 z-20 min-h-12 min-w-0 border-r border-b px-3 py-2"
            >
              <h2 className="text-sm font-semibold">
                <Link
                  to={dayHref(day)}
                  aria-current={day === today ? "date" : undefined}
                  className={cn(
                    "hover:bg-hover inline-flex rounded-md px-1 py-0.5",
                    day === today && "bg-selected",
                  )}
                >
                  {formatDateWith(locale, berlinDayStartMs(day), {
                    weekday: "short",
                    day: "numeric",
                    month: "short",
                  })}
                </Link>
              </h2>
              <div
                className={days.length === 1 ? "flex flex-wrap gap-x-4 [&>a]:max-w-72" : undefined}
              >
                <TaskMarkers tasks={tasks} day={day} limit={days.length === 1 ? undefined : 2} />
              </div>
              {days.length > 1 &&
              tasks.filter((task) => berlinDayIndex(new Date(task.dueAt)) === day).length > 2 ? (
                <Link
                  to={dayHref(day)}
                  className="hover:bg-hover mt-1 inline-flex rounded-sm px-1 py-1 text-xs"
                >
                  {t("events.calendar.more", {
                    count:
                      tasks.filter((task) => berlinDayIndex(new Date(task.dueAt)) === day).length -
                      2,
                  })}
                </Link>
              ) : null}
            </div>
          ))}
          {days.map((day, column) => {
            const hours = dayHours(day);
            const timeKeys = hours.map((instant) => berlinLocalString(instant).slice(11, 16));
            const tabRow = Math.max(0, timeKeys.indexOf("09:00"));
            return (
              <section
                key={day}
                aria-label={dayIndexToDateKey(day)}
                className="border-border min-w-0 border-r last:border-r-0"
              >
                <div className="relative" style={{ height: hours.length * 48 }}>
                  {hours.map((instant, row) => (
                    <Link
                      key={instant}
                      to={instantSlotHref(instant)}
                      tabIndex={row === tabRow ? 0 : -1}
                      data-slot-row={row}
                      data-slot-column={column}
                      data-slot-time={Number(timeKeys[row].slice(0, 2)) * 60}
                      aria-label={t("events.calendar.createAt", {
                        date: dayIndexToDateKey(day),
                        time: formatDateWith(locale, instant, {
                          hour: "2-digit",
                          minute: "2-digit",
                          timeZoneName: "short",
                          hourCycle: "h23",
                        }),
                      })}
                      className="border-border hover:bg-hover text-muted-foreground absolute inset-x-0 flex h-12 items-start border-b px-2 pt-1 text-xs focus-visible:z-30"
                      style={{ top: row * 48 }}
                    >
                      <span className="nums">
                        {timeKeys.indexOf(timeKeys[row]) !== timeKeys.lastIndexOf(timeKeys[row])
                          ? formatDateWith(locale, instant, {
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZoneName: "short",
                              hourCycle: "h23",
                            })
                          : formatTime(locale, instant)}
                      </span>
                    </Link>
                  ))}
                  {arrangeEvents(events, day).map(({ event, start, end, lane, lanes }) => (
                    <Link
                      key={event.id}
                      to={`/events/${event.id}`}
                      title={`${event.title} · ${formatDateWith(locale, event.startsAt, { dateStyle: "short", timeStyle: "long" })}–${formatDateWith(locale, event.endsAt, { dateStyle: "short", timeStyle: "long" })}`}
                      className="group bg-card shadow-surface-1 text-foreground absolute z-10 isolate flex min-w-0 flex-col gap-0.5 overflow-hidden rounded-md px-2 py-1 focus-visible:z-30"
                      style={{
                        top: ((start - berlinDayStartMs(day)) / 3_600_000) * 48,
                        height: Math.max(30, ((end - start) / 3_600_000) * 48 - 2),
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                      }}
                    >
                      <span
                        aria-hidden
                        className="bg-tint group-hover:bg-tint-hover pointer-events-none absolute inset-0 -z-10 rounded-[inherit]"
                      />
                      <EventLabel
                        event={event}
                        narrow={days.length > 1}
                        height={Math.max(30, ((end - start) / 3_600_000) * 48 - 2)}
                        short={((end - start) / 3_600_000) * 48 - 2 < 76}
                        dense={lanes > 1 || ((end - start) / 3_600_000) * 48 - 2 < 108}
                      />
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function RoomsTimeline({
  rooms,
  bookings,
  day,
}: {
  rooms: { id: string; name: string }[];
  bookings: CalendarBooking[];
  day: number;
}) {
  const locale = useLocale();
  const t = useT();
  const ref = React.useRef<HTMLDivElement>(null);
  const hours = dayHours(day);
  const timeKeys = hours.map((instant) => berlinLocalString(instant).slice(11, 16));
  const start = berlinDayStartMs(day);
  const end = berlinDayStartMs(day + 1);
  React.useLayoutEffect(() => {
    if (ref.current) ref.current.scrollLeft = 6 * 88;
  }, [day]);
  return (
    <div className="bg-card shadow-surface-2 overflow-hidden rounded-lg">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="text-base font-semibold">{t("events.calendar.roomAvailability")}</h2>
        <p className="text-muted-foreground text-xs">{t("events.calendar.roomsHint")}</p>
      </div>
      {rooms.length > 0 ? (
        <p className="text-muted-foreground border-border flex items-center gap-2 border-b px-4 py-2 text-xs">
          <MoveHorizontal className="size-4 shrink-0" aria-hidden />
          {t("events.calendar.scrollHours", { count: hours.length })}
        </p>
      ) : null}
      {rooms.length === 0 ? (
        <p className="text-muted-foreground p-6 text-sm">{t("events.calendar.noRooms")}</p>
      ) : (
        <div
          ref={ref}
          className="max-h-[680px] scroll-pt-14 scroll-pl-[188px] overflow-auto"
          data-slot-orientation="horizontal"
          onKeyDown={navigateSlots}
        >
          <div style={{ width: 180 + hours.length * 88 }}>
            <div className="bg-card sticky top-0 z-30 flex min-h-12">
              <div className="bg-card border-border sticky left-0 z-40 w-[180px] shrink-0 border-r border-b px-3 py-2 text-sm font-semibold">
                {t("events.detail.rooms")}
              </div>
              {hours.map((instant, column) => (
                <div
                  key={instant}
                  className="text-muted-foreground nums border-border w-[88px] shrink-0 border-r border-b px-2 py-2 text-xs"
                >
                  {timeKeys.indexOf(timeKeys[column]) !== timeKeys.lastIndexOf(timeKeys[column])
                    ? formatDateWith(locale, instant, {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZoneName: "short",
                        hourCycle: "h23",
                      })
                    : formatTime(locale, instant)}
                </div>
              ))}
            </div>
            {rooms.map((room, row) => {
              const occupied = bookings.filter((booking) => booking.roomId === room.id);
              const freeColumns = hours.flatMap((instant, column) =>
                occupied.some(
                  (booking) =>
                    +new Date(booking.startsAt) < instant + 3_600_000 &&
                    +new Date(booking.endsAt) > instant,
                )
                  ? []
                  : [column],
              );
              const tabColumn =
                freeColumns.find((column) => timeKeys[column] === "09:00") ?? freeColumns[0];
              return (
                <section
                  key={room.id}
                  aria-label={room.name}
                  className="border-border relative flex h-24 border-b last:border-b-0"
                >
                  <h3 className="bg-card border-border sticky left-0 z-20 flex w-[180px] shrink-0 items-center border-r px-3 text-sm font-semibold">
                    <span className="line-clamp-3 min-w-0 wrap-anywhere" title={room.name}>
                      {room.name}
                    </span>
                  </h3>
                  <div className="relative flex flex-1">
                    {hours.map((instant, column) => {
                      return !freeColumns.includes(column) ? (
                        <div key={instant} className="border-border w-[88px] shrink-0 border-r" />
                      ) : (
                        <Link
                          key={instant}
                          to={instantSlotHref(instant, room.id)}
                          tabIndex={column === tabColumn ? 0 : -1}
                          data-slot-column={column}
                          data-slot-row={row}
                          aria-label={t("events.calendar.bookRoomAt", {
                            room: room.name,
                            time: formatDateWith(locale, instant, {
                              hour: "2-digit",
                              minute: "2-digit",
                              timeZoneName: "short",
                              hourCycle: "h23",
                            }),
                          })}
                          className="border-border hover:bg-hover group flex w-[88px] shrink-0 items-center justify-center border-r focus-visible:z-30"
                        >
                          <Plus
                            className="text-muted-foreground size-4 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                            aria-hidden
                          />
                        </Link>
                      );
                    })}
                    {occupied.map((booking) => {
                      const token = statusToken(locale, "event", booking.status);
                      const left =
                        ((Math.max(start, +new Date(booking.startsAt)) - start) / 3_600_000) * 88;
                      const width =
                        ((Math.min(end, +new Date(booking.endsAt)) -
                          Math.max(start, +new Date(booking.startsAt))) /
                          3_600_000) *
                        88;
                      return (
                        <Link
                          key={booking.id}
                          to={`/events/${booking.eventId}`}
                          className="group bg-card shadow-surface-1 absolute top-4 bottom-4 z-10 isolate flex min-w-0 flex-col justify-center gap-1 overflow-hidden rounded-md px-2"
                          title={`${booking.title} · ${formatTime(locale, booking.startsAt)}–${formatTime(locale, booking.endsAt)}`}
                          style={{ left: left + 2, width: Math.max(16, width - 4) }}
                        >
                          <span
                            aria-hidden
                            className="bg-tint group-hover:bg-tint-hover pointer-events-none absolute inset-0 -z-10 rounded-[inherit]"
                          />
                          <span className="flex min-w-0 items-center gap-1 text-xs font-semibold">
                            <span
                              aria-hidden
                              className={cn("size-1.5 shrink-0 rounded-full", token.dotClassName)}
                            />
                            <span
                              className={cn(
                                "line-clamp-2 min-w-0 wrap-anywhere",
                                booking.status === "CANCELLED" && "line-through",
                              )}
                            >
                              {booking.title}
                            </span>
                            <span className="sr-only">{token.label}</span>
                          </span>
                          <span className="nums text-muted-foreground truncate text-xs">
                            {formatTime(locale, booking.startsAt)}–
                            {formatTime(locale, booking.endsAt)}
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
