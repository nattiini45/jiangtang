import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { NotFoundError, toErrorResponse } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { getRoomDashboard } from "~/domains/rooms/rooms.dashboard.server";
import { getRoomBySlug } from "~/domains/rooms/rooms.queries.server";
import { markRoomChecked } from "~/domains/rooms/rooms.mutations.server";
import { RoomDashboard } from "~/components/rooms/room-dashboard";
import { QrCode } from "~/components/qr/qr-code";
import { qrSvg } from "~/lib/qr.server";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "rooms.meta.detail", {
        name: data?.data.room.name ?? t(locale, "rooms.meta.fallbackName"),
      }),
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const data = await getRoomDashboard(params.slug);
  if (!data) throw toErrorResponse(new NotFoundError(tr("err.room.notFound")));
  // The room QR encodes the quick-entry URL pre-filled with this room —
  // scanning it on site opens "log an entry for this room" directly.
  const origin = new URL(request.url).origin;
  const qrHref = `${origin}/quick-entry?roomId=${data.room.id}`;
  const qr = await qrSvg(qrHref);
  return { data, qr, qrHref };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  try {
    const room = await getRoomBySlug(params.slug);
    if (!room) throw new NotFoundError(tr("err.room.notFound"));
    await markRoomChecked(actor, room.id);
    return { checked: true };
  } catch (error) {
    throw toErrorResponse(error);
  }
}

export default function RoomDashboardRoute({ loaderData }: Route.ComponentProps) {
  return (
    <div className="flex flex-col gap-6">
      <RoomDashboard data={loaderData.data} />
      <QrCode svg={loaderData.qr} href={loaderData.qrHref} titleKey="qr.room.title" />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
