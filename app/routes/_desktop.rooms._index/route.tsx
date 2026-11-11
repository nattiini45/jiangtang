import * as React from "react";
import { Form, Link, redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { resolveLocale } from "~/i18n/locale.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { listCampuses, listRooms } from "~/domains/rooms/rooms.queries.server";
import {
  buildingCreateSchema,
  buildingEditSchema,
  campusCreateSchema,
  campusEditSchema,
} from "~/domains/rooms/rooms.schema";
import {
  createBuilding,
  createCampus,
  updateBuilding,
  updateCampus,
} from "~/domains/rooms/rooms.mutations.server";
import { RoomStatus } from "~/generated/prisma/enums";
import { statusToken } from "~/lib/status";
import { DataGrid } from "~/components/data-grid";
import { roomColumns } from "~/components/rooms/room-columns";
import { CampusesManager, type CampusActionData } from "~/components/rooms/campuses-manager";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "rooms.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const manage = url.searchParams.get("manage") === "campuses" ? "campuses" : null;
  const campusId = url.searchParams.get("campus") || undefined;
  const statusParam = url.searchParams.get("status") || "";
  const status = statusParam in RoomStatus ? (statusParam as RoomStatus) : undefined;

  // Campuses are always loaded: the list page's filter picker and the
  // manage-campuses view both need them.
  const campuses = await listCampuses();
  const rooms = manage ? [] : await listRooms({ campusId, status });
  return {
    rooms,
    campuses,
    manage,
    filters: { campus: campusId ?? "", status: status ?? "" },
  };
}

/**
 * The campus/building intents — the CRUD moved here from `/campuses` when the
 * manage-mode moved into `/rooms?manage=campuses`; the forms in
 * `CampusesManager` post to this route.
 */
export async function action({ request }: Route.ActionArgs): Promise<CampusActionData | Response> {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const obj = formDataToObject(await request.formData());
  const intent = String(obj._action ?? "");
  try {
    switch (intent) {
      case "createCampus": {
        const r = safeParse(campusCreateSchema, obj, locale);
        if (!r.success) return { intent, fieldErrors: r.fieldErrors };
        const c = await createCampus(actor, r.data);
        await emitChange({ entityType: "campus", id: c.id, op: "created" });
        return redirect("/rooms?manage=campuses");
      }
      case "updateCampus": {
        const r = safeParse(campusEditSchema, obj, locale);
        if (!r.success) return { intent, id: String(obj.id ?? ""), fieldErrors: r.fieldErrors };
        const c = await updateCampus(actor, r.data.id, r.data);
        await emitChange({ entityType: "campus", id: c.id, op: "updated" });
        return redirect("/rooms?manage=campuses");
      }
      case "createBuilding": {
        const r = safeParse(buildingCreateSchema, obj, locale);
        if (!r.success)
          return { intent, campusId: String(obj.campusId ?? ""), fieldErrors: r.fieldErrors };
        const b = await createBuilding(actor, r.data);
        await emitChange({ entityType: "building", id: b.id, op: "created" });
        return redirect("/rooms?manage=campuses");
      }
      case "updateBuilding": {
        const r = safeParse(buildingEditSchema, obj, locale);
        if (!r.success) return { intent, id: String(obj.id ?? ""), fieldErrors: r.fieldErrors };
        const b = await updateBuilding(actor, r.data.id, r.data);
        await emitChange({ entityType: "building", id: b.id, op: "updated" });
        return redirect("/rooms?manage=campuses");
      }
      default:
        return { intent };
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      return {
        intent,
        id: String(obj.id ?? ""),
        campusId: String(obj.campusId ?? ""),
        fieldErrors: e.fieldErrors,
      };
    }
    throw toErrorResponse(e);
  }
}

export default function RoomsList({ loaderData, actionData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const columns = React.useMemo(() => roomColumns(t), [t]);
  const { rooms, campuses, manage, filters } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) =>
    e.currentTarget.form?.requestSubmit();

  if (manage === "campuses") {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">{t("campuses.title")}</h1>
            <p className="text-muted-foreground text-sm">{t("campuses.subtitle")}</p>
          </div>
          <Button asChild variant="tertiary">
            <Link to="/rooms">{t("nav.rooms")}</Link>
          </Button>
        </div>
        <CampusesManager campuses={campuses} actionData={actionData} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("rooms.list.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("rooms.list.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="tertiary">
            <Link to="/rooms?manage=campuses">{t("rooms.list.manageCampuses")}</Link>
          </Button>
          <Button asChild>
            <Link to="/rooms/new">{t("rooms.list.new")}</Link>
          </Button>
        </div>
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
        growColumn="knownIssues"
        data={rooms}
        getRowId={(r) => r.id}
        emptyMessage={t("rooms.list.empty")}
        maxHeight={640}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
