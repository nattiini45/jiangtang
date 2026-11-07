import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listEvents } from "~/domains/events/events.queries.server";
import { eventStatusLabel } from "~/components/events/labels";
import { EmptyState } from "~/components/states/empty-state";
import { Button } from "~/components/ui/button";
import { SegmentLink } from "~/components/ui/segment-link";
import { CalendarDays } from "lucide-react";
import {
  berlinDayIndex,
  berlinDayStartMs,
  dayIndexToDateKey,
  dayIndexToIsoWeek,
  isoWeekRange,
} from "~/lib/berlin-days";
import { berlinLocalString } from "~/lib/berlin-days";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile events — today and this week (Berlin). `?scope=week` widens the list
 * to the rest of the ISO week; the default is today. Cancelled events are
 * filtered out here; the DB stays the only place the booking invariant lives.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "mobile.meta.events") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const scope = new URL(request.url).searchParams.get("scope") === "week" ? "week" : "today";

  const today = berlinDayIndex(new Date());
  const { endDay } = isoWeekRange(dayIndexToIsoWeek(today));
  const from = new Date(berlinDayStartMs(today));
  const to = new Date(berlinDayStartMs(scope === "week" ? endDay + 1 : today + 1));

  const events = (await listEvents({ from, to })).filter((e) => e.status !== "CANCELLED");
  return {
    events,
    scope,
    todayKey: dayIndexToDateKey(today),
  };
}

export default function MobileEventsIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { events, scope, todayKey } = loaderData;
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("nav.events")}</h1>
        <Button asChild className="min-h-11">
          <Link to="/m/events/new">{t("mobile.events.new")}</Link>
        </Button>
      </div>

      <div className="bg-tint flex rounded-full p-0.5">
        <SegmentLink to="/m/events" active={scope === "today"} label={t("mobile.events.today")} />
        <SegmentLink
          to="/m/events?scope=week"
          active={scope === "week"}
          label={t("mobile.events.week")}
        />
      </div>

      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {events.map((e) => {
          const start = berlinLocalString(e.startsAt);
          const dayKey = start.slice(0, 10);
          return (
            <li key={e.id}>
              <Link
                to={`/events/${e.id}`}
                className="active:bg-selected flex min-h-12 flex-col justify-center gap-0.5 px-3 py-2 transition-colors duration-80"
              >
                <div className="truncate text-sm font-semibold">{e.title}</div>
                <p className="text-muted-foreground nums truncate text-xs">
                  {[
                    dayKey === todayKey ? null : dayKey,
                    `${start.slice(11, 16)}–${berlinLocalString(e.endsAt).slice(11, 16)}`,
                    eventStatusLabel(locale, e.status),
                    e.roomCount > 0 ? t("mobile.events.rooms", { count: e.roomCount }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </Link>
            </li>
          );
        })}
        {events.length === 0 ? (
          <li>
            <EmptyState
              icon={CalendarDays}
              title={t("mobile.events.empty")}
              action={{ to: "/m/events/new", label: t("mobile.events.create") }}
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
