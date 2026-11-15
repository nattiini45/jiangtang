import { Link, redirect, useLocation, useNavigation } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { hasMobileEquivalent, viewPath } from "~/lib/view.server";
import { calendarChoices, getWorkspaceCalendar } from "~/domains/calendar/calendar.queries.server";
import { calendarKinds } from "~/lib/calendar-entries";
import { calendarRange, calendarSlotHref, parseCalendarDate } from "~/lib/event-calendar";
import { berlinDayIndex, berlinDayStartMs, dayIndexToDateKey } from "~/lib/berlin-days";
import { EventStatus } from "~/generated/prisma/enums";
import { parseEnumParam } from "~/lib/validation.server";
import { CalendarFilters } from "~/components/events/calendar-filters";
import { eventStatusLabel } from "~/components/events/labels";
import { cn } from "~/lib/utils";
import { ViewSwitch } from "~/components/layout/view-switch";
import { Button, buttonVariants } from "~/components/ui/button";
import { formatDateWith, formatTime } from "~/i18n/format";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "calendar.meta") }];
}
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const params = new URL(request.url).searchParams;
  const day = parseCalendarDate(params.get("date"));
  if (params.has("date") && params.get("date") !== dayIndexToDateKey(day)) {
    params.set("date", dayIndexToDateKey(day));
    throw redirect(`/m/calendar?${params}`);
  }
  const calendar = await getWorkspaceCalendar({
    ...calendarRange(day, "day"),
    kinds: calendarKinds(params, calendarChoices),
    roomId: params.get("room") || undefined,
    equipmentId: params.get("equipment") || undefined,
    status: parseEnumParam(EventStatus, params.get("status")),
  });
  return {
    ...calendar,
    entries: calendar.entries.map((entry) => ({
      ...entry,
      mobileHref: hasMobileEquivalent(entry.href)
        ? viewPath(`${entry.href}?date=${dayIndexToDateKey(day)}`, "mobile")
        : null,
    })),
    choices: calendarChoices,
    day,
    date: dayIndexToDateKey(day),
  };
}
export default function MobileCalendar({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const location = useLocation();
  const navigation = useNavigation();
  const current =
    navigation.location?.pathname === location.pathname ? navigation.location : location;
  const params = new URLSearchParams(current.search);
  if (!params.has("date")) params.set("date", loaderData.date);
  const day = parseCalendarDate(params.get("date"));
  const href = (selected: number) => {
    const next = new URLSearchParams(params);
    next.set("date", dayIndexToDateKey(selected));
    return `?${next}`;
  };
  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4" aria-busy={navigation.state !== "idle"}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("nav.calendar")}</h1>
        <Button asChild>
          <Link to={calendarSlotHref(day, 9, undefined, true)}>{t("events.list.new")}</Link>
        </Button>
      </header>
      <div className="flex items-center justify-between gap-2">
        <Link
          to={href(day - 1)}
          aria-label={t("events.calendar.previous")}
          className={buttonVariants({ variant: "tertiary", size: "icon" })}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </Link>
        <h2 className="text-base font-semibold">
          {formatDateWith(locale, berlinDayStartMs(loaderData.day), {
            weekday: "short",
            day: "numeric",
            month: "short",
          })}
        </h2>
        <Link
          to={href(day + 1)}
          aria-label={t("events.calendar.next")}
          className={buttonVariants({ variant: "tertiary", size: "icon" })}
        >
          <ChevronRight className="size-4" aria-hidden />
        </Link>
        <Link
          to={href(berlinDayIndex(new Date()))}
          className={buttonVariants({ variant: "ghost" })}
        >
          {t("events.calendar.today")}
        </Link>
      </div>
      <CalendarFilters
        params={params}
        choices={loaderData.choices}
        rooms={loaderData.rooms}
        equipment={loaderData.equipment}
        mobile
      />
      {params.get("room") || params.get("equipment") ? (
        <p className="text-muted-foreground text-xs">{t("calendar.resourceHint")}</p>
      ) : null}
      <p className="text-muted-foreground text-xs">{t("mobile.timeZone")}</p>
      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {loaderData.entries.map((entry) => {
          const spansDays =
            berlinDayIndex(+new Date(entry.endsAt) - 1) > berlinDayIndex(new Date(entry.startsAt));
          const when = entry.allDay
            ? t("calendar.wholeDay")
            : entry.point
              ? formatTime(locale, entry.startsAt)
              : `${formatTime(locale, entry.startsAt)}–${formatTime(locale, entry.endsAt)}`;
          const content = (
            <>
              <span className="text-muted-foreground text-xs">
                {t(entry.kind)} · {when}
                {spansDays
                  ? ` · ${formatDateWith(locale, entry.startsAt, { day: "numeric", month: "short" })}–${formatDateWith(locale, +new Date(entry.endsAt) - 1, { day: "numeric", month: "short" })}`
                  : ""}
                {entry.status ? ` · ${eventStatusLabel(locale, entry.status)}` : ""}
              </span>
              <span
                className={cn(
                  "break-words text-sm font-semibold",
                  entry.status === "CANCELLED" && "line-through",
                )}
              >
                {entry.title}
              </span>
              <span className="text-muted-foreground break-words text-xs">
                {[...entry.rooms, ...entry.equipment].map((resource) => resource.name).join(" · ")}
              </span>
            </>
          );
          const className =
            "hover:bg-hover active:bg-selected flex min-h-16 w-full flex-col gap-1 px-3 py-3 text-left";
          return (
            <li key={entry.id}>
              {entry.mobileHref ? (
                <Link to={entry.mobileHref} className={className}>
                  {content}
                </Link>
              ) : (
                <ViewSwitch view="desktop" desktopLabel next={entry.href} className={className}>
                  {content}
                </ViewSwitch>
              )}
            </li>
          );
        })}
        {!loaderData.entries.length ? (
          <li className="text-muted-foreground p-4 text-sm">{t("calendar.empty")}</li>
        ) : null}
      </ul>
    </div>
  );
}
export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
