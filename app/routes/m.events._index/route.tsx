import { Form, Link, redirect } from "react-router";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { getCalendarData } from "~/domains/events/events.calendar.queries.server";
import { eventStatusLabel } from "~/components/events/labels";
import { EmptyState } from "~/components/states/empty-state";
import { Button, buttonVariants } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { berlinDayIndex, berlinDayStartMs, dayIndexToDateKey } from "~/lib/berlin-days";
import { calendarRange, calendarSlotHref, parseCalendarDate } from "~/lib/event-calendar";
import { formatDateWith, formatTime } from "~/i18n/format";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "mobile.meta.events") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const params = new URL(request.url).searchParams;
  const day = parseCalendarDate(params.get("date"));
  const date = dayIndexToDateKey(day);
  if (params.has("date") && params.get("date") !== date) throw redirect(`/m/events?date=${date}`);
  const range = calendarRange(day, "day");
  const calendar = await getCalendarData({ from: range.from, to: range.to });
  return { events: calendar.events.filter((event) => event.status !== "CANCELLED"), day, date };
}

export default function MobileEventsIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { events, day, date } = loaderData;
  const createHref = calendarSlotHref(day, 9, undefined, true);
  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("nav.events")}</h1>
        <Button asChild className="min-h-11">
          <Link to={createHref}>{t("events.list.new")}</Link>
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Link
          to={`?date=${dayIndexToDateKey(day - 1)}`}
          aria-label={t("events.calendar.previous")}
          className={`${buttonVariants({ variant: "tertiary", size: "icon" })} min-h-11 min-w-11`}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Link>
        <Form
          key={date}
          method="get"
          onChange={(event) => event.currentTarget.requestSubmit()}
          className="min-w-0 flex-1"
        >
          <Input
            type="date"
            name="date"
            defaultValue={date}
            min="1900-01-01"
            max="2100-12-31"
            aria-label={t("events.calendar.date")}
            className="min-h-11"
          />
          <noscript>
            <Button type="submit">{t("events.list.filterSubmit")}</Button>
          </noscript>
        </Form>
        <Link
          to={`?date=${dayIndexToDateKey(day + 1)}`}
          aria-label={t("events.calendar.next")}
          className={`${buttonVariants({ variant: "tertiary", size: "icon" })} min-h-11 min-w-11`}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Link>
      </div>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">
          {formatDateWith(locale, berlinDayStartMs(day), {
            weekday: "long",
            day: "numeric",
            month: "short",
          })}
        </h2>
        <Link
          to={`?date=${dayIndexToDateKey(berlinDayIndex(new Date()))}`}
          className={`${buttonVariants({ variant: "ghost", size: "compact" })} min-h-11`}
        >
          {t("events.calendar.today")}
        </Link>
      </div>
      <p className="text-muted-foreground text-xs">Europe/Berlin</p>
      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {events.map((event) => {
          const spansDays =
            berlinDayIndex(new Date(event.endsAt)) !== berlinDayIndex(new Date(event.startsAt));
          return (
            <li key={event.id}>
              <Link
                to={`/m/events/${event.id}?date=${date}`}
                className="hover:bg-hover active:bg-selected flex min-h-16 w-full flex-col gap-1 px-3 py-3 text-left"
              >
                <span className="text-muted-foreground nums text-xs">
                  {spansDays
                    ? `${formatDateWith(locale, event.startsAt, { day: "numeric", month: "short" })} · `
                    : ""}
                  {formatTime(locale, event.startsAt)} –{" "}
                  {spansDays
                    ? `${formatDateWith(locale, event.endsAt, { day: "numeric", month: "short" })} · `
                    : ""}
                  {formatTime(locale, event.endsAt)}
                </span>
                <span className="break-words text-sm font-semibold">{event.title}</span>
                <span className="text-muted-foreground break-words text-xs">
                  {[
                    ...event.rooms.map((room) => room.name),
                    ...event.equipment.map((item) => item.name),
                    eventStatusLabel(locale, event.status),
                  ].join(" · ")}
                </span>
              </Link>
            </li>
          );
        })}
        {events.length === 0 ? (
          <li>
            <EmptyState
              icon={CalendarDays}
              title={t("mobile.events.empty")}
              action={{ to: createHref, label: t("mobile.events.create") }}
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
