import * as React from "react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { listCampuses, listRooms } from "~/domains/rooms/rooms.queries.server";
import { RoomStatus } from "~/generated/prisma/enums";
import { statusToken } from "~/lib/status";
import { DataGrid } from "~/components/data-grid";
import { roomColumns } from "~/components/rooms/room-columns";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "rooms.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const campusId = url.searchParams.get("campus") || undefined;
  const statusParam = url.searchParams.get("status") || "";
  const status = statusParam in RoomStatus ? (statusParam as RoomStatus) : undefined;

  const [rooms, campuses] = await Promise.all([listRooms({ campusId, status }), listCampuses()]);
  return { rooms, campuses, filters: { campus: campusId ?? "", status: status ?? "" } };
}

export default function RoomsList({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const columns = React.useMemo(() => roomColumns(t), [t]);
  const { rooms, campuses, filters } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) =>
    e.currentTarget.form?.requestSubmit();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("rooms.list.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("rooms.list.subtitle")}</p>
        </div>
        <Button asChild>
          <Link to="/rooms/new">{t("rooms.list.new")}</Link>
        </Button>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <Select
          name="campus"
          aria-label={t("rooms.list.filterCampus")}
          defaultValue={filters.campus}
          className="max-w-64"
          onChange={autoSubmit}
        >
          <option value="">{t("rooms.list.allCampuses")}</option>
          {campuses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          name="status"
          aria-label={t("rooms.list.filterStatus")}
          defaultValue={filters.status}
          className="max-w-56"
          onChange={autoSubmit}
        >
          <option value="">{t("rooms.list.allStatuses")}</option>
          {Object.values(RoomStatus).map((s) => (
            <option key={s} value={s}>
              {statusToken(locale, "room", s).label}
            </option>
          ))}
        </Select>
        <noscript>
          <Button type="submit" variant="tertiary" size="compact">
            {t("rooms.list.filterSubmit")}
          </Button>
        </noscript>
      </Form>

      <DataGrid
        columns={columns}
        data={rooms}
        getRowId={(r) => r.id}
        emptyMessage={t("rooms.list.empty")}
        maxHeight={640}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
