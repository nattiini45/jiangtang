import { Link } from "react-router";
import { ViewSwitch } from "~/components/layout/view-switch";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { NotFoundError, toErrorResponse } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { getRoomDashboard } from "~/domains/rooms/rooms.dashboard.server";
import { listAttachments } from "~/domains/attachments/attachments.queries.server";
import { QrCode } from "~/components/qr/qr-code";
import { qrSvg } from "~/lib/qr.server";
import { StatusBadge } from "~/components/ui/status-badge";
import { Button } from "~/components/ui/button";
import { categoryLabel } from "~/components/inventory/labels";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

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
  const data = await getRoomDashboard(params.slug!);
  if (!data) throw toErrorResponse(new NotFoundError(tr("err.room.notFound")));
  const attachments = await listAttachments({ roomId: data.room.id });
  // Same QR as the desktop room page: scan → quick entry pre-filled with this room.
  const origin = new URL(request.url).origin;
  const qrHref = `${origin}/quick-entry?roomId=${data.room.id}`;
  const qr = await qrSvg(qrHref);
  return { data, attachments, qr, qrHref };
}

export default function MobileRoomDetail({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { room, equipment, openTickets } = loaderData.data;
  const { attachments } = loaderData;
  return (
    <div className="flex flex-col gap-6 px-4 py-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{room.name}</h1>
          <StatusBadge kind="room" value={room.status} />
        </div>
        <p className="text-muted-foreground nums text-xs">
          {room.roomNumber ? <span className="font-mono">{room.roomNumber}</span> : null}
          {room.roomNumber && room.campus?.name ? " · " : null}
          {room.campus?.name}
        </p>
      </div>

      <Button asChild className="min-h-11 w-full">
        <Link to={`/m?roomId=${room.id}`}>{t("mobile.rooms.newEntry")}</Link>
      </Button>

      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">{t("mobile.rooms.installed")}</h2>
        {equipment.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("mobile.rooms.noEquipment")}</p>
        ) : (
          <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
            {equipment.map((e) => (
              <li key={e.id} className="flex min-h-12 items-center gap-2 px-3 py-2 text-sm">
                <span className="flex-1 truncate">{e.name ?? e.modelName ?? "—"}</span>
                <span className="text-muted-foreground text-xs">
                  {categoryLabel(locale, e.category)}
                </span>
                <StatusBadge kind="equipment" value={e.status} />
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

      <QrCode svg={loaderData.qr} href={loaderData.qrHref} titleKey="qr.room.title" />

      <ViewSwitch
        view="desktop"
        next={`/rooms/${room.slug}`}
        className="text-muted-foreground flex min-h-11 w-full items-center justify-center text-xs underline decoration-(--input) underline-offset-4"
      >
        {t("mobile.rooms.desktopView")}
      </ViewSwitch>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
