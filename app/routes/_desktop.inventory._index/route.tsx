import * as React from "react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listDeviceKinds } from "~/lib/equipment-kinds/kinds.server";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";
import { KindOptions, type KindGroups } from "~/components/inventory/kind-options";
import { listEquipment } from "~/domains/inventory/inventory.queries.server";
import { listModels } from "~/domains/catalog/catalog.queries.server";
import { listStock } from "~/domains/inventory/inventory.stock.queries.server";
import { stockListOptionsSchema } from "~/domains/inventory/inventory.stock.schema";
import { listLocationTree } from "~/domains/locations/locations.tree.server";
import { listVendors } from "~/domains/vendors/vendors.queries.server";
import { listFrequencyBoard } from "~/domains/inventory/inventory.frequency.server";
import { parseInput } from "~/lib/validation.server";
import { EquipmentCategory, EquipmentMobility, EquipmentStatus } from "~/generated/prisma/enums";
import { statusToken } from "~/lib/status";
import { mobilityLabel } from "~/components/inventory/labels";
import { DataGrid } from "~/components/data-grid";
import { equipmentColumns } from "~/components/inventory/equipment-columns";
import { ModelsPanel } from "~/components/inventory/models-panel";
import { StockPanel } from "~/components/inventory/stock-panel";
import { FrequencyPanel } from "~/components/frequency/frequency-panel";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";
import { getListColumns, withListValues } from "~/lib/list-columns/columns.server";
import type { ListColumns, ListValues } from "~/lib/list-columns/columns";
import { withFieldColumns } from "~/components/data-grid/field-columns";
import { ColumnPicker } from "~/components/data-grid/column-picker";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "inventory.meta.list") }];
}

type InventoryTab = "equipment" | "models" | "stock" | "frequencies";

const TABS: {
  id: InventoryTab;
  labelKey:
    | "inventory.tab.equipment"
    | "inventory.tab.models"
    | "inventory.tab.stock"
    | "inventory.tab.frequencies";
}[] = [
  { id: "equipment", labelKey: "inventory.tab.equipment" },
  { id: "models", labelKey: "inventory.tab.models" },
  { id: "stock", labelKey: "inventory.tab.stock" },
  { id: "frequencies", labelKey: "inventory.tab.frequencies" },
];

export async function loader({ request }: Route.LoaderArgs) {
  const user = await requireUser(request);
  const url = new URL(request.url);
  const tabParam = url.searchParams.get("tab") || "";
  const tab: InventoryTab = (
    TABS.some((x) => x.id === tabParam) ? tabParam : "equipment"
  ) as InventoryTab;

  if (tab === "models") {
    return { tab, models: await listModels() };
  }
  if (tab === "frequencies") {
    return { tab, groups: await listFrequencyBoard() };
  }
  if (tab === "stock") {
    // The filter lives in the URL and nowhere else, so a copied link reproduces the view.
    // Parsed through the domain's own options schema rather than field by field — that is
    // what keeps this list and `listStock`'s contract from drifting apart. Garbage degrades
    // rather than throws, and not only because the schema is lenient: every field is an
    // *optional string*, so `?location=not-a-real-id` parses cleanly and yields an empty
    // list, while `parseInput` would have thrown a 422 on a shape the schema cannot produce.
    const options = parseInput(stockListOptionsSchema, {
      locationId: url.searchParams.get("location") ?? undefined,
      vendorId: url.searchParams.get("vendor") ?? undefined,
      search: url.searchParams.get("q") ?? undefined,
      includeUnassigned: url.searchParams.get("hideUnassigned") === "1" ? false : undefined,
    });
    const [items, locations, vendors] = await Promise.all([
      listStock(options),
      listLocationTree(),
      // The picker's source. Loaded unconditionally, exactly as the location tree is -
      // a picker whose options depend on the current filter would be a control that lies
      // about what can still be selected.
      listVendors(),
    ]);
    return {
      tab,
      stock: {
        items,
        locations,
        vendors,
        filters: {
          locationId: options.locationId ?? "",
          vendorId: options.vendorId ?? "",
          search: options.search ?? "",
          includeUnassigned: options.includeUnassigned,
        },
      },
    };
  }

  const categoryParam = url.searchParams.get("category") || "";
  const statusParam = url.searchParams.get("status") || "";
  const mobilityParam = url.searchParams.get("mobility") || "";
  const category =
    categoryParam in EquipmentCategory ? (categoryParam as EquipmentCategory) : undefined;
  const status = statusParam in EquipmentStatus ? (statusParam as EquipmentStatus) : undefined;
  const mobility =
    mobilityParam in EquipmentMobility ? (mobilityParam as EquipmentMobility) : undefined;

  const kinds = await listDeviceKinds();
  const kindId = url.searchParams.get("kindId") || undefined;
  const columnConfig = await getListColumns("EQUIPMENT", user.role === "ADMIN");
  const equipment = await withListValues(
    "EQUIPMENT",
    await listEquipment({ kindId, category, status, mobility }),
    columnConfig.columns,
  );
  return {
    tab,
    equipment: {
      equipment,
      kinds,
      columnConfig,
      canConfigure: user.role === "ADMIN",
      filters: {
        kindId:
          kindId ??
          (category
            ? kinds
                .flatMap((group) => group.kinds)
                .find((kind) => kind.systemKey === DEFAULT_EQUIPMENT_KINDS[category].key)?.id
            : undefined) ??
          "",
        status: status ?? "",
        mobility: mobility ?? "",
      },
    },
  };
}

export default function InventoryIndex({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const { tab } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement>) =>
    e.currentTarget.form?.requestSubmit();

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* Section tabs — plain links so they are keyboard-reachable and the section
          lives in the URL (`?tab=`), shareable like every other filter. */}
      <nav aria-label={t("inventory.tabs.aria")} className="flex border-b">
        {TABS.map((tabDef) => (
          <Link
            key={tabDef.id}
            to={tabDef.id === "equipment" ? "/inventory" : `/inventory?tab=${tabDef.id}`}
            aria-current={tab === tabDef.id ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === tabDef.id
                ? "border-primary text-foreground font-semibold"
                : "text-muted-foreground hover:text-foreground border-transparent"
            }`}
          >
            {t(tabDef.labelKey)}
          </Link>
        ))}
      </nav>

      {tab === "models" && "models" in loaderData ? (
        <ModelsPanel models={loaderData.models} />
      ) : null}
      {tab === "frequencies" && "groups" in loaderData ? (
        <FrequencyPanel groups={loaderData.groups} />
      ) : null}
      {tab === "stock" && "stock" in loaderData ? <StockPanel {...loaderData.stock} /> : null}

      {tab === "equipment" && "equipment" in loaderData ? (
        <EquipmentPanel
          equipment={loaderData.equipment.equipment}
          kinds={loaderData.equipment.kinds}
          filters={loaderData.equipment.filters}
          columnConfig={loaderData.equipment.columnConfig}
          canConfigure={loaderData.equipment.canConfigure}
          autoSubmit={autoSubmit}
        />
      ) : null}
    </div>
  );
}

function EquipmentPanel({
  equipment,
  kinds,
  filters,
  columnConfig,
  canConfigure,
  autoSubmit,
}: {
  equipment: (Awaited<ReturnType<typeof listEquipment>>[number] & ListValues)[];
  kinds: KindGroups;
  filters: { kindId: string; status: string; mobility: string };
  columnConfig: ListColumns;
  canConfigure: boolean;
  autoSubmit: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}) {
  const locale = useLocale();
  const t = useT();
  const columns = React.useMemo(
    () =>
      withFieldColumns(
        equipmentColumns<(typeof equipment)[number]>(t, locale),
        columnConfig,
        locale,
      ),
    [t, locale, columnConfig],
  );
  const builtins = equipmentColumns(t, locale).map((column) => ({
    id: String(column.id ?? ("accessorKey" in column ? column.accessorKey : "")),
    label: String(column.header),
  }));
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("inventory.list.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("inventory.list.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {canConfigure ? (
            <ColumnPicker scope="EQUIPMENT" config={columnConfig} builtins={builtins} />
          ) : null}
          <Button asChild>
            <Link to="/inventory/new">{t("inventory.list.new")}</Link>
          </Button>
        </div>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <Select
          name="kindId"
          aria-label={t("inventory.list.filterKind")}
          defaultValue={filters.kindId}
          className="max-w-[14rem]"
          onChange={autoSubmit}
        >
          <option value="">{t("inventory.list.allKinds")}</option>
          <KindOptions groups={kinds} />
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
        growColumn="name"
        stickyColumn="name"
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
