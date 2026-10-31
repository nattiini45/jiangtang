import type { Route } from "./+types/route";
import { NotFoundError, toErrorResponse } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { getRoomDashboard } from "~/domains/rooms/rooms.dashboard.server";
import { RoomDashboard } from "~/components/rooms/room-dashboard";
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

export async function loader({ params }: Route.LoaderArgs) {
  const data = await getRoomDashboard(params.slug);
  if (!data) throw toErrorResponse(new NotFoundError(tr("err.room.notFound")));
  return { data };
}

export default function RoomDashboardRoute({ loaderData }: Route.ComponentProps) {
  return <RoomDashboard data={loaderData.data} />;
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
