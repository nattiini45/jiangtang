import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listRooms } from "~/domains/rooms/rooms.queries.server";
import { StatusBadge } from "~/components/ui/status-badge";
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
    <div className="flex flex-col">
      <div className="border-border border-b px-4 py-3">
        <h1 className="font-mono text-lg">{t("nav.rooms")}</h1>
      </div>
      <ul className="divide-border divide-y">
        {rooms.map((r) => (
          <li key={r.id}>
            <Link
              to={`/m/rooms/${r.slug}`}
              className="flex items-center gap-3 px-4 py-3 active:bg-accent"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-base">{r.name}</p>
                <p className="text-muted-foreground font-mono text-xs">
                  {[r.roomNumber, r.campusName].filter(Boolean).join(" · ") || "—"}
                </p>
              </div>
              <StatusBadge kind="room" value={r.status} />
            </Link>
          </li>
        ))}
        {rooms.length === 0 ? (
          <li className="text-muted-foreground p-4 text-sm">{t("mobile.rooms.empty")}</li>
        ) : null}
      </ul>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
