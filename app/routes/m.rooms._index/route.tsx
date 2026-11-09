import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listRooms } from "~/domains/rooms/rooms.queries.server";
import { StatusBadge } from "~/components/ui/status-badge";
import { EmptyState } from "~/components/states/empty-state";
import { DoorOpen } from "lucide-react";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * Mobile room list. A tappable, single-column list — the desktop's
 * dense grid reflowed for a phone. Reuses listRooms (read-only) so the data layer
 * is shared, not forked.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "rooms.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const rooms = await listRooms();
  return { rooms };
}

export default function MobileRoomsIndex({ loaderData }: Route.ComponentProps) {
  const { rooms } = loaderData;
  const t = useT();
  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 [overflow-wrap:anywhere]">
      <h1 className="text-lg font-semibold">{t("nav.rooms")}</h1>
      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {rooms.map((r) => (
          <li key={r.id}>
            <Link
              to={`/m/rooms/${r.slug}`}
              className="hover:bg-hover active:bg-selected flex min-h-12 flex-wrap items-center gap-3 px-3 py-3 transition-colors duration-80"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{r.name}</p>
                <p className="text-muted-foreground nums text-xs">
                  {r.roomNumber ? <span className="font-mono">{r.roomNumber}</span> : null}
                  {r.roomNumber && r.campusName ? " · " : null}
                  {r.campusName || (r.roomNumber ? null : "—")}
                </p>
              </div>
              <StatusBadge kind="room" value={r.status} />
            </Link>
          </li>
        ))}
        {rooms.length === 0 ? (
          <li>
            <EmptyState icon={DoorOpen} title={t("mobile.rooms.empty")} />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
