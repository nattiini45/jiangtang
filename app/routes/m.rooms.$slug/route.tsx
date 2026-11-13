import { Form, Link, redirect } from "react-router";
import { useState } from "react";
import { RoomFunctions } from "~/components/rooms/room-functions";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { ViewSwitch } from "~/components/layout/view-switch";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { FieldValues } from "~/components/fields/field-values";
import { NotFoundError, toErrorResponse } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { getRoomDashboard } from "~/domains/rooms/rooms.dashboard.server";
import { getCalendarData } from "~/domains/events/events.calendar.queries.server";
import { EmptyState } from "~/components/states/empty-state";
import { Input } from "~/components/ui/input";
import { berlinDayIndex, berlinDayStartMs, dayIndexToDateKey } from "~/lib/berlin-days";
import { calendarRange, calendarSlotHref, parseCalendarDate } from "~/lib/event-calendar";
import { formatDateWith, formatRange } from "~/i18n/format";
import { QrCode } from "~/components/qr/qr-code";
import { qrSvg } from "~/lib/qr.server";
import { StatusBadge } from "~/components/ui/status-badge";
import { Button, buttonVariants } from "~/components/ui/button";
import { categoryLabel } from "~/components/inventory/labels";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";
import { readingDevices } from "~/domains/readings/readings.queries.server";

/**
 * Mobile room detail. A condensed view of the desktop dashboard —
 * installed gear, open tickets, and a quick-entry deep link. Reuses the desktop
 * dashboard loader (read-only) so the projection is shared.
 */
export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  const name = data?.data.room.name ?? translate(locale, "rooms.meta.fallbackName");
  return [{ title: translate(locale, "rooms.meta.detail", { name }) }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  try {
    const data = await getRoomDashboard(params.slug!);
    if (!data) throw new NotFoundError(tr("err.room.notFound"));
    const search = new URL(request.url).searchParams;
    const day = parseCalendarDate(search.get("date"));
    const date = dayIndexToDateKey(day);
    if (search.has("date") && search.get("date") !== date)
      throw redirect(`/m/rooms/${data.room.slug}?date=${date}`);
    const range = calendarRange(day, "day");
    const calendar = await getCalendarData({
      from: range.from,
      to: range.to,
      roomId: data.room.id,
    });
    const attachments = data.attachments;
    // Same QR as the desktop room page: scan → quick entry pre-filled with this room.
    const origin = new URL(request.url).origin;
    const qrHref = `${origin}/quick-entry?roomId=${data.room.id}`;
    const qr = await qrSvg(qrHref);
    return {
      data,
      readingDeviceIds: (await readingDevices({ roomId: data.room.id })).map((device) => device.id),
      attachments,
      qr,
      qrHref,
      day,
      date,
      bookings: calendar.bookings.filter((booking) => booking.status !== "CANCELLED"),
    };
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export default function MobileRoomDetail({ loaderData }: Route.ComponentProps) {
  const [opened, setOpened] = useState<string[]>([]);
  const locale = useLocale();
  const t = useT();
  const { room, equipment, openTickets } = loaderData.data;
  const { attachments, day, date, bookings } = loaderData;
  const createHref = calendarSlotHref(day, 9, room.id, true);
  return (
    <div className="flex min-w-0 flex-col gap-6 px-4 py-4 [overflow-wrap:anywhere]">
      <div className="flex flex-col gap-1">
        <Link
          to="/m/rooms"
          className={`${buttonVariants({ variant: "tertiary" })} min-h-11 self-start`}
        >
          {t("mobileDetails.roomBack")}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-bold">{room.name}</h1>
        </div>
        {room.roomTypeName ? (
          <p className="text-sm text-muted-foreground">
            {t("functions.types.label")}: {room.roomTypeName}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t("mobileDetails.roomStatus")}</span>
          <StatusBadge kind="room" value={room.status} />
        </div>
        <p className="text-muted-foreground nums text-xs">
          {room.roomNumber ? <span className="font-mono">{room.roomNumber}</span> : null}
          {room.roomNumber && room.campus?.name ? " · " : null}
          {room.campus?.name}
        </p>
      </div>

      <Button asChild className="min-h-11 w-full">
        <Link to={`/m/quick-entry?roomId=${room.id}`}>{t("mobile.rooms.newEntry")}</Link>
      </Button>
      <FieldValues fields={room.fields} foldAfter={8} />
      <RoomFunctions
        functions={loaderData.data.functions}
        roomId={room.id}
        roomStatus={room.status}
        roomSlug={room.slug}
        knownIssues={room.knownIssues}
        fixFunctions={loaderData.data.fixFunctions}
        mobile
      />

      <section className="flex min-w-0 flex-col gap-3">
        <h2 className="text-base font-semibold">{t("mobileDetails.schedule")}</h2>
        <p className="text-muted-foreground text-sm">{t("mobileDetails.scheduleHint")}</p>
        <div className="flex items-center gap-2">
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
              <Button type="submit" className="min-h-11">
                {t("events.list.filterSubmit")}
              </Button>
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
          <p className="text-sm font-semibold">
            {formatDateWith(locale, berlinDayStartMs(day), {
              weekday: "long",
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </p>
          <Link
            to={`?date=${dayIndexToDateKey(berlinDayIndex(new Date()))}`}
            className={`${buttonVariants({ variant: "ghost" })} min-h-11`}
          >
            {t("events.calendar.today")}
          </Link>
        </div>
        <p className="text-muted-foreground text-xs">{t("mobile.timeZone")}</p>
        {bookings.length ? (
          <ul className="bg-card shadow-surface-2 divide-y rounded-lg">
            {bookings.map((booking) => (
              <li key={booking.id}>
                <Link
                  to={`/m/events/${booking.eventId}?date=${date}`}
                  className="hover:bg-hover active:bg-selected flex min-h-11 flex-col items-start gap-1 px-3 py-3"
                >
                  <span className="nums text-xs text-muted-foreground">
                    {formatRange(locale, booking.startsAt, booking.endsAt)}
                  </span>
                  <span className="text-sm font-semibold">{booking.title}</span>
                  <StatusBadge kind="event" value={booking.status} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={CalendarDays} title={t("mobileDetails.noBookings")} />
        )}
        <Button asChild variant="secondary" className="min-h-11">
          <Link to={createHref}>{t("events.list.new")}</Link>
        </Button>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">{t("mobile.rooms.installed")}</h2>
        {equipment.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("mobile.rooms.noEquipment")}</p>
        ) : (
          <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
            {equipment.map((e) => (
              <li key={e.id}>
                <Link
                  to={`/m/quick-entry?roomId=${room.id}&equipmentId=${e.id}`}
                  className="hover:bg-hover active:bg-selected flex min-h-12 flex-wrap items-center gap-2 px-3 py-3 text-sm"
                >
                  <span className="min-w-0 flex-1">{e.name ?? e.modelName ?? "—"}</span>
                  <span className="text-muted-foreground text-xs">
                    {categoryLabel(locale, e.category)}
                  </span>
                  <StatusBadge kind="equipment" value={e.status} />
                  <span className="text-muted-foreground basis-full text-xs">
                    {t("mobileDetails.reportEquipment", {
                      name: e.name ?? e.modelName ?? "—",
                    })}
                  </span>
                </Link>
                {loaderData.readingDeviceIds.includes(e.id) ? (
                  <Link
                    to={`/m/inventory/${e.id}/readings`}
                    className="inline-flex min-h-12 items-center px-3 text-sm underline underline-offset-4"
                  >
                    {t("readings.enterAndHistory")}
                  </Link>
                ) : null}
                {e.fields.length ? (
                  <div className="px-3 pb-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="compact"
                      aria-expanded={opened.includes(e.id)}
                      aria-label={`${t(opened.includes(e.id) ? "fields.values.hide" : "fields.values.show")}: ${t(
                        "fields.values.forDevice",
                        {
                          name: e.name ?? e.modelName ?? e.kind.name,
                        },
                      )}`}
                      aria-controls={`values-${e.id}`}
                      onClick={() =>
                        setOpened((ids) =>
                          ids.includes(e.id) ? ids.filter((id) => id !== e.id) : [...ids, e.id],
                        )
                      }
                    >
                      {t(opened.includes(e.id) ? "fields.values.hide" : "fields.values.show")}
                    </Button>
                    <div id={`values-${e.id}`} hidden={!opened.includes(e.id)} className="py-3">
                      {opened.includes(e.id) ? <FieldValues fields={e.fields} /> : null}
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">
          {t("mobile.rooms.openTickets")} {openTickets.length > 0 ? `(${openTickets.length})` : ""}
        </h2>
        {openTickets.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("mobile.rooms.noOpenTickets")}</p>
        ) : (
          <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
            {openTickets.map((ticket) => (
              <li key={ticket.id}>
                <Link
                  to={`/m/tickets/${ticket.id}`}
                  className="active:bg-selected flex min-h-12 items-center px-3 py-2 text-sm transition-colors duration-80"
                >
                  {ticket.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {attachments.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">{t("mobile.stockDetail.attachments")}</h2>
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <a key={a.id} href={`/attachments/${a.objectKey}`}>
                <img
                  src={`/attachments/${a.objectKey}?thumb=1`}
                  alt={a.filename}
                  className="size-20 rounded-md object-cover"
                />
              </a>
            ))}
          </div>
        </section>
      ) : null}

      <details className="group">
        <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold">
          <ChevronDown className="size-4 group-open:rotate-180" aria-hidden />
          {t("mobileDetails.qr")}
        </summary>
        <QrCode svg={loaderData.qr} href={loaderData.qrHref} titleKey="qr.room.title" />
      </details>

      <ViewSwitch
        view="desktop"
        next={`/rooms/${room.slug}?date=${date}`}
        className="text-muted-foreground flex min-h-11 w-full items-center justify-center text-xs underline decoration-(--input) underline-offset-4"
      >
        {t("mobile.rooms.desktopView")}
      </ViewSwitch>
    </div>
  );
}

export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
