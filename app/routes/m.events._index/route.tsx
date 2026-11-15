import { Form, Link, redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listEventsForPlanning } from "~/domains/events/events.queries.server";
import { EventStatus } from "~/generated/prisma/enums";
import { parseEnumParam } from "~/lib/validation.server";
import { eventStatusLabel } from "~/components/events/labels";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { formatDateTime } from "~/i18n/format";
import { berlinDateKey } from "~/lib/berlin-days";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "mobile.meta.events") }];
}
export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const params = new URL(request.url).searchParams;
  if (params.has("date")) throw redirect(`/m/calendar?${params}`);
  const status = parseEnumParam(EventStatus, params.get("status"));
  return { events: await listEventsForPlanning(status), status: status ?? "" };
}
export default function MobileEvents({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("nav.events")}</h1>
        <Button asChild>
          <Link to="/m/events/new">{t("events.list.new")}</Link>
        </Button>
      </header>
      <Form
        key={loaderData.status}
        method="get"
        onChange={(event) => event.currentTarget.requestSubmit()}
      >
        <Select
          name="status"
          aria-label={t("events.list.filterStatus")}
          defaultValue={loaderData.status}
        >
          <option value="">{t("events.list.allStatuses")}</option>
          {Object.values(EventStatus).map((status) => (
            <option key={status} value={status}>
              {eventStatusLabel(locale, status)}
            </option>
          ))}
        </Select>
        <noscript>
          <Button type="submit">{t("events.list.filterSubmit")}</Button>
        </noscript>
      </Form>
      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {loaderData.events.map((event) => (
          <li key={event.id} className="p-3">
            <Link to={`/m/events/${event.id}`} className="hover:underline">
              <span className="break-words text-sm font-semibold">{event.title}</span>
              <span className="text-muted-foreground mt-1 block text-xs">
                {formatDateTime(locale, event.startsAt)} – {formatDateTime(locale, event.endsAt)}
              </span>
              <span className="text-muted-foreground mt-1 block break-words text-xs">
                {[...event.roomNames, eventStatusLabel(locale, event.status)].join(" · ")}
              </span>
            </Link>
            <Link
              to={`/m/calendar?date=${berlinDateKey(event.startsAt)}`}
              className="hover:underline mt-2 inline-flex min-h-11 items-center text-sm"
            >
              {t("calendar.openDay")}
            </Link>
          </li>
        ))}
        {!loaderData.events.length ? (
          <li className="text-muted-foreground p-4 text-sm">{t("events.list.empty")}</li>
        ) : null}
      </ul>
    </div>
  );
}
export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
