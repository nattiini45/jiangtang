import * as React from "react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listEquipment } from "~/domains/inventory/inventory.queries.server";
import { EquipmentCategory, EquipmentMobility, EquipmentStatus } from "~/generated/prisma/enums";
import { statusToken } from "~/lib/status";
import { categoryLabel, mobilityLabel } from "~/components/inventory/labels";
import { DataGrid } from "~/components/data-grid";
import { equipmentColumns } from "~/components/inventory/equipment-columns";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "inventory.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const categoryParam = url.searchParams.get("category") || "";
  const statusParam = url.searchParams.get("status") || "";
  const mobilityParam = url.searchParams.get("mobility") || "";
  const category =
    categoryParam in EquipmentCategory ? (categoryParam as EquipmentCategory) : undefined;
  const status = statusParam in EquipmentStatus ? (statusParam as EquipmentStatus) : undefined;
  const mobility =
    mobilityParam in EquipmentMobility ? (mobilityParam as EquipmentMobility) : undefined;

  const equipment = await listEquipment({ category, status, mobility });
  return {
    equipment,
    filters: { category: category ?? "", status: status ?? "", mobility: mobility ?? "" },
  };
}

export default function InventoryIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const columns = React.useMemo(() => equipmentColumns(t, locale), [t, locale]);
  const { equipment, filters } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) =>
    e.currentTarget.form?.requestSubmit();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("inventory.list.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("inventory.list.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="tertiary">
            <Link to="/inventory/models">{t("inventory.list.models")}</Link>
          </Button>
          <Button asChild>
            <Link to="/inventory/new">{t("inventory.list.new")}</Link>
          </Button>
        </div>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <Select
          name="category"
          aria-label={t("inventory.list.filterCategory")}
          defaultValue={filters.category}
          className="max-w-[14rem]"
          onChange={autoSubmit}
        >
          <option value="">{t("inventory.list.allCategories")}</option>
          {Object.values(EquipmentCategory).map((c) => (
            <option key={c} value={c}>
              {categoryLabel(locale, c)}
            </option>
          ))}
        </Select>
        <Select
          name="status"
          aria-label={t("inventory.list.filterStatus")}
          defaultValue={filters.status}
          className="max-w-[12rem]"
          onChange={autoSubmit}
        >
          <option value="">{t("inventory.list.allStatuses")}</option>
          {Object.values(EquipmentStatus).map((s) => (
            <option key={s} value={s}>
              {statusToken(locale, "equipment", s).label}
            </option>
          ))}
        </Select>
        <Select
          name="mobility"
          aria-label={t("inventory.list.filterMobility")}
          defaultValue={filters.mobility}
          className="max-w-[12rem]"
          onChange={autoSubmit}
        >
          <option value="">{t("inventory.list.allMobility")}</option>
          {Object.values(EquipmentMobility).map((m) => (
            <option key={m} value={m}>
              {mobilityLabel(locale, m)}
            </option>
          ))}
        </Select>
        <noscript>
          <Button type="submit" variant="tertiary" size="compact">
            {t("inventory.list.filterSubmit")}
          </Button>
        </noscript>
      </Form>

      <DataGrid
        columns={columns}
        data={equipment}
        getRowId={(e) => e.id}
        emptyMessage={t("inventory.list.empty")}
        maxHeight={640}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
