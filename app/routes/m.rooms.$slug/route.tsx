import { Link } from "react-router";
import type { Route } from "./+types/route";
import { NotFoundError, toErrorResponse } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { getRoomDashboard } from "~/domains/rooms/rooms.dashboard.server";
import { StatusBadge } from "~/components/ui/status-badge";
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

export async function loader({ params }: Route.LoaderArgs) {
  const data = await getRoomDashboard(params.slug!);
  if (!data) throw toErrorResponse(new NotFoundError(tr("err.room.notFound")));
  return { data };
}

export default function MobileRoomDetail({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { room, equipment, openTickets } = loaderData.data;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="font-mono text-lg">{room.name}</h1>
          <StatusBadge kind="room" value={room.status} />
        </div>
        <p className="text-muted-foreground font-mono text-xs">
          {[room.roomNumber, room.campus?.name].filter(Boolean).join(" · ")}
        </p>
      </div>

      <Link
        to={`/m?roomId=${room.id}`}
        className="bg-primary text-primary-foreground rounded-sm px-4 py-3 text-center text-sm font-medium"
      >
        {t("mobile.rooms.newEntry")}
      </Link>

      <section>
        <h2 className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
          {t("mobile.rooms.installed")}
        </h2>
        {equipment.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("mobile.rooms.noEquipment")}</p>
        ) : (
          <ul className="divide-border border-border divide-y border">
            {equipment.map((e) => (
              <li key={e.id} className="flex items-center gap-2 px-2 py-2 text-sm">
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

      <section>
        <h2 className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
          {t("mobile.rooms.openTickets")} {openTickets.length > 0 ? `(${openTickets.length})` : ""}
        </h2>
        {openTickets.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("mobile.rooms.noOpenTickets")}</p>
        ) : (
          <ul className="divide-border border-border divide-y border">
            {openTickets.map((ticket) => (
              <li key={ticket.id} className="px-2 py-2">
                <Link to={`/m/tickets/${ticket.id}`} className="block text-sm hover:underline">
                  {ticket.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Link
        to={`/rooms/${room.slug}`}
        className="text-muted-foreground text-center text-xs underline"
      >
        {t("mobile.rooms.desktopView")}
      </Link>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
