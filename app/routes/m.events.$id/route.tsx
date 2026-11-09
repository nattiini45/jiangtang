import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { NotFoundError, toErrorResponse } from "~/lib/errors.server";
import { getEventDetail } from "~/domains/events/events.queries.server";
import { ViewSwitch } from "~/components/layout/view-switch";
import { StatusBadge } from "~/components/ui/status-badge";
import { CalendarSyncPanel } from "~/components/events/calendar-sync-panel";
import { serviceWindowKindLabel } from "~/components/events/labels";
import { buttonVariants } from "~/components/ui/button";
import { dayIndexToDateKey } from "~/lib/berlin-days";
import { parseCalendarDate } from "~/lib/event-calendar";
import { formatRange } from "~/i18n/format";
import { t as translate } from "~/i18n";
import { tr } from "~/i18n/request-locale.server";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: translate(locale, "events.meta.detail", {
        title: data?.detail.event.title ?? translate(locale, "events.meta.fallbackTitle"),
      }),
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  try {
    const detail = await getEventDetail(params.id!);
    if (!detail) throw new NotFoundError(tr("err.event.notFound"));
    const day = parseCalendarDate(
      new URL(request.url).searchParams.get("date"),
      detail.event.startsAt,
    );
    return { detail, date: dayIndexToDateKey(day) };
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export default function MobileEventDetail({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  const {
    detail: { event, rooms, allocations, serviceWindows, tickets, calendarSync },
    date,
  } = loaderData;
  return (
    <div className="flex min-w-0 flex-col gap-6 px-4 py-4 [overflow-wrap:anywhere]">
      <header className="flex min-w-0 flex-col items-start gap-2">
        <Link
          to={`/m/events?date=${date}`}
          className={`${buttonVariants({ variant: "tertiary" })} min-h-11`}
        >
          {t("mobileDetails.eventBack")}
        </Link>
        <h1 className="text-lg font-bold">{event.title}</h1>
        <StatusBadge kind="event" value={event.status} />
      </header>
      <CalendarSyncPanel sync={calendarSync} />
      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("mobileDetails.eventTime")}</h2>
        <p className="nums text-sm">{formatRange(locale, event.startsAt, event.endsAt)}</p>
        <p className="text-muted-foreground text-xs">{t("mobile.timeZone")}</p>
        <dl className="space-y-2 text-sm">
          {event.organizer ? (
            <div>
              <dt className="text-muted-foreground">{t("events.form.organizer")}</dt>
              <dd>{event.organizer}</dd>
            </div>
          ) : null}
          {event.contact ? (
            <div>
              <dt className="text-muted-foreground">{t("events.form.contact")}</dt>
              <dd className="whitespace-pre-wrap">{event.contact}</dd>
            </div>
          ) : null}
        </dl>
      </section>
      {event.description ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">{t("events.form.description")}</h2>
          <p className="whitespace-pre-wrap text-sm">{event.description}</p>
        </section>
      ) : null}
      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("events.detail.rooms")}</h2>
        {rooms.length ? (
          <ul className="bg-card shadow-surface-2 divide-y rounded-lg">
            {rooms.map((room) => (
              <li key={room.id}>
                <Link
                  to={`/m/rooms/${room.roomSlug}?date=${date}`}
                  className="hover:bg-hover active:bg-selected flex min-h-11 flex-col gap-1 px-3 py-3"
                >
                  <span className="text-sm font-semibold">{room.roomName}</span>
                  <span className="text-muted-foreground nums text-xs">
                    {formatRange(locale, room.startsAt, room.endsAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{t("events.detail.noRooms")}</p>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("events.detail.pooledEquipment")}</h2>
        {allocations.length ? (
          <ul className="bg-card shadow-surface-2 divide-y rounded-lg">
            {allocations.map((item) => (
              <li key={item.id} className="space-y-1 px-3 py-3">
                <p className="text-sm font-semibold">{item.equipmentName}</p>
                <p className="text-muted-foreground nums text-xs">
                  {formatRange(locale, item.startsAt, item.endsAt)}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{t("events.detail.noAllocations")}</p>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-base font-semibold">{t("events.detail.serviceWindows")}</h2>
        {serviceWindows.length ? (
          <ul className="bg-card shadow-surface-2 divide-y rounded-lg">
            {serviceWindows.map((window) => (
              <li key={window.id} className="space-y-1 px-3 py-3 text-sm">
                <p className="font-semibold">{serviceWindowKindLabel(locale, window.kind)}</p>
                <p className="text-muted-foreground nums text-xs">
                  {formatRange(locale, window.startsAt, window.endsAt)}
                </p>
                {window.roomName ? <p>{window.roomName}</p> : null}
                {window.covering ? <p>{window.covering}</p> : null}
                {window.notes ? <p className="whitespace-pre-wrap">{window.notes}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-sm">{t("events.detail.noServiceWindows")}</p>
        )}
      </section>
      {tickets.length ? (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">{t("events.detail.tickets")}</h2>
          <ul className="bg-card shadow-surface-2 divide-y rounded-lg">
            {tickets.map((ticket) => (
              <li key={ticket.id}>
                <Link
                  to={`/m/tickets/${ticket.id}`}
                  className="hover:bg-hover active:bg-selected flex min-h-11 items-center gap-2 px-3 py-3 text-sm"
                >
                  <span className="min-w-0 flex-1">{ticket.title}</span>
                  <StatusBadge kind="ticket" value={ticket.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ViewSwitch
        view="desktop"
        next={`/events/${event.id}`}
        className="text-muted-foreground flex min-h-11 items-center justify-center text-sm underline underline-offset-4"
      >
        {t("mobileDetails.desktop")}
      </ViewSwitch>
    </div>
  );
}

export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
