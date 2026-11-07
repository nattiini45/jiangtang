import * as React from "react";
import { Form, Link } from "react-router";
import type { LocationTreeNode } from "~/domains/locations/locations.tree.server";
import type { VendorOption } from "~/domains/vendors/vendors.queries.server";
import type { StockListRow } from "~/components/inventory/stock-columns";
import { DataGrid } from "~/components/data-grid";
import { stockColumns } from "~/components/inventory/stock-columns";
import { kindLabel } from "~/components/locations/labels";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { useLocale, useT } from "~/i18n/use-t";

export interface StockPanelFilters {
  locationId: string;
  vendorId: string;
  search: string;
  includeUnassigned?: boolean;
}

/**
 * The general-stock panel of the `/inventory` tabs. `/inventory/stock` used to
 * be its own page; it now redirects to `/inventory?tab=stock` and this renders.
 * The filter form keeps `tab=stock` in the URL via a hidden input, so a
 * submitted filter lands back on this tab.
 */
export function StockPanel({
  items,
  locations,
  vendors,
  filters,
}: {
  items: StockListRow[];
  locations: LocationTreeNode[];
  vendors: VendorOption[];
  filters: StockPanelFilters;
}) {
  const locale = useLocale();
  const t = useT();
  const columns = React.useMemo(() => stockColumns(t), [t]);
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
    e.currentTarget.form?.requestSubmit();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("inventory.stock.list.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("inventory.stock.list.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {/* Equipment keeps its own tab: `/inventory` and `/inventory/:id` still mean
              `Equipment`. Cross-linking the two namespaces is what makes that split
              legible from either side. */}
          <Button asChild variant="tertiary">
            <Link to="/inventory">{t("inventory.stock.list.devices")}</Link>
          </Button>
          <Button asChild>
            <Link to="/inventory/stock/new">{t("inventory.stock.list.new")}</Link>
          </Button>
        </div>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="tab" value="stock" />
        <Input
          name="q"
          defaultValue={filters.search}
          placeholder={t("inventory.stock.list.searchPlaceholder")}
          className="max-w-[16rem]"
          aria-label={t("inventory.stock.list.searchLabel")}
        />
        {/* The supplier filter, shaped exactly like the location one below it: same
            auto-submit, same visible-button fallback for a no-JS visitor. */}
        <Select
          name="vendor"
          defaultValue={filters.vendorId}
          className="max-w-[18rem]"
          onChange={autoSubmit}
        >
          <option value="">{t("inventory.stock.list.allVendors")}</option>
          {vendors.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </Select>
        <Select
          name="location"
          defaultValue={filters.locationId}
          className="max-w-[18rem]"
          onChange={autoSubmit}
        >
          <option value="">{t("inventory.stock.list.allLocations")}</option>
          {locations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {/* Real depth, so the picker cannot present a ROOM as a peer of its
                  BUILDING — the same reason `m.locations` indents its rows. */}
              {`${"— ".repeat(loc.depth)}${loc.name} · ${kindLabel(locale, loc.kind)}`}
            </option>
          ))}
        </Select>
        {/* the flag is real now — an unchecked box simply sends no
            `hideUnassigned` param, which is `includeUnassigned`'s default. */}
        <label className="text-muted-foreground flex items-center gap-2 text-sm">
          <Checkbox
            name="hideUnassigned"
            value="1"
            defaultChecked={filters.includeUnassigned === false}
            onChange={autoSubmit}
          />
          {t("inventory.stock.list.hideUnassigned")}
        </label>
        {/* A real button, not a `noscript` one: the select auto-submits via JS, so without
            a visible submit the filter would be unreachable for anyone whose JS has not
            loaded — and an unreachable control reads as a broken feature. */}
        <Button type="submit" variant="tertiary" size="compact">
          {t("inventory.stock.list.filterSubmit")}
        </Button>
      </Form>

      <DataGrid
        columns={columns}
        data={items}
        getRowId={(i) => i.id}
        emptyMessage={t("inventory.stock.list.empty")}
        maxHeight={640}
      />
    </div>
  );
}
