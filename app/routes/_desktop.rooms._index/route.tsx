import * as React from "react";
import { Form, Link, redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse, parseInput } from "~/lib/validation.server";
import { setRoomType } from "~/domains/rooms/room-types.mutations.server";
import { setRoomTypeSchema } from "~/domains/rooms/room-types.schema";
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
import { getListColumns, withListValues } from "~/lib/list-columns/columns.server";
import { withFieldColumns } from "~/components/data-grid/field-columns";
import { ColumnPicker } from "~/components/data-grid/column-picker";
import { listDeviceKinds } from "~/lib/equipment-kinds/kinds.server";
import { KindOptions } from "~/components/inventory/kind-options";
import { listRoomTypes } from "~/domains/rooms/room-types.queries.server";
import { RoomTypeBulk } from "~/components/rooms/room-type-bulk";
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox";
import { Check } from "lucide-react";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "rooms.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const manage = url.searchParams.get("manage") === "campuses" ? "campuses" : null;
  const campusId = url.searchParams.get("campus") || undefined;
  const kindId = url.searchParams.get("kindId") || undefined;
  const statusParam = url.searchParams.get("status") || "";
  const status = statusParam in RoomStatus ? (statusParam as RoomStatus) : undefined;

  // Campuses are always loaded: the list page's filter picker and the
  // manage-campuses view both need them.
  const campuses = await listCampuses();
  const columnConfig = await getListColumns("ROOM", user.role === "ADMIN");
  const rooms = await withListValues(
    "ROOM",
    manage ? [] : await listRooms({ campusId, status, kindId }),
    columnConfig.columns,
  );
  const kinds = await listDeviceKinds();
  return {
    rooms,
    roomTypes: await listRoomTypes(),
    campuses,
    manage,
    kinds,
    columnConfig,
    canConfigure: user.role === "ADMIN",
    filters: { campus: campusId ?? "", status: status ?? "", kindId: kindId ?? "" },
  };
}

/**
 * The campus/building intents — the CRUD moved here from `/campuses` when the
 * manage-mode moved into `/rooms?manage=campuses`; the forms in
 * `CampusesManager` post to this route.
 */
export async function action({
  request,
}: Route.ActionArgs): Promise<CampusActionData | Response | { saved?: boolean; error?: string }> {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const obj = formDataToObject(await request.formData());
  const intent = String(obj._action ?? "");
  try {
    switch (intent) {
      case "setRoomType": {
        const type = String(obj.roomTypeId ?? "none");
        await setRoomType(
          actor,
          parseInput(setRoomTypeSchema, {
            roomIds: Array.isArray(obj.roomIds) ? obj.roomIds : obj.roomIds ? [obj.roomIds] : [],
            roomTypeId: type === "none" ? null : type,
          }),
        );
        return { saved: true };
      }
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
      if (intent === "setRoomType") return { error: t(locale, "functions.types.invalid") };
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
  const [selected, setSelected] = React.useState<string[]>([]);
  const { rooms, campuses, manage, filters, kinds, columnConfig, canConfigure } = loaderData;
  const columns = React.useMemo(
    () => [
      {
        id: "selection",
        header: t("functions.types.selection"),
        meta: { sizing: "short" as const },
        enableSorting: false,
        cell: ({ row }: { row: { original: (typeof rooms)[number] } }) => (
          <Checkbox
            aria-label={t("functions.types.select", { name: row.original.name })}
            checked={selected.includes(row.original.id)}
            onCheckedChange={(checked) =>
              setSelected((ids) =>
                checked ? [...ids, row.original.id] : ids.filter((id) => id !== row.original.id),
              )
            }
            className="flex size-5 items-center justify-center rounded-sm shadow-[inset_0_0_0_1px_var(--input)] data-checked:bg-selected"
          >
            <CheckboxIndicator>
              <Check aria-hidden className="size-4" />
            </CheckboxIndicator>
          </Checkbox>
        ),
      },
      ...withFieldColumns(roomColumns<(typeof rooms)[number]>(t), columnConfig, locale),
    ],
    [t, columnConfig, locale, selected],
  );
  const builtins = roomColumns(t).map((column) => ({
    id: String(column.id ?? ("accessorKey" in column ? column.accessorKey : "")),
    label: String(column.header),
  }));
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
        <CampusesManager
          campuses={campuses}
          actionData={actionData && "intent" in actionData ? actionData : undefined}
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("rooms.list.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("rooms.list.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {canConfigure ? (
            <ColumnPicker scope="ROOM" config={columnConfig} builtins={builtins} />
          ) : null}
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
        <Select
          name="kindId"
          aria-label={t("inventory.list.filterKind")}
          defaultValue={filters.kindId}
          className="max-w-56"
          onChange={autoSubmit}
        >
          <option value="">{t("inventory.list.allKinds")}</option>
          <KindOptions groups={kinds} />
        </Select>
        <noscript>
          <Button type="submit" variant="tertiary" size="compact">
            {t("rooms.list.filterSubmit")}
          </Button>
        </noscript>
      </Form>

      <RoomTypeBulk
        ids={selected.filter((id) => rooms.some((room) => room.id === id))}
        types={loaderData.roomTypes}
      />
      <DataGrid
        widthsMenu={!canConfigure}
        columns={columns}
        growColumn="name"
        stickyColumn="name"
        data={rooms}
        getRowId={(r) => r.id}
        emptyMessage={t("rooms.list.empty")}
        maxHeight={640}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
