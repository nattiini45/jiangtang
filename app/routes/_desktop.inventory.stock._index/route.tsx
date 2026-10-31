import * as React from "react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/route";
import { listStock } from "~/domains/inventory/inventory.stock.queries.server";
import { stockListOptionsSchema } from "~/domains/inventory/inventory.stock.schema";
import { listLocationTree } from "~/domains/locations/locations.tree.server";
import { listVendors } from "~/domains/vendors/vendors.queries.server";
import { parseInput } from "~/lib/validation.server";
import { DataGrid } from "~/components/data-grid";
import { stockColumns } from "~/components/inventory/stock-columns";
import { kindLabel } from "~/components/locations/labels";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/inventory/stock` — the general-stock list.
 *
 * **This route removes a live shadow rather than adding a surface.** `/inventory/stock`
 * is a *static* segment, and a static segment with nothing behind it does not 404 — the
 * router falls through to the dynamic sibling `/inventory/:id` and renders the
 * **Equipment detail page** at the canonical stock URL. Silently, because a cursed link
 * renders a real page rather than an error. `test/routes/route-resolution.test.ts` is the
 * guard, and it measured both ends of this fix: `$id` before, `stock._index` after.
 *
 * **No `requireUser` here**, for the reason every other `_desktop` route omits it: the
 * tree is auth-guarded at `app/routes/_desktop/route.tsx`, and a second copy would be a
 * second thing to drift.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "inventory.meta.stock") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // The filter lives in the URL and nowhere else, so a copied link reproduces the view.
  // Parsed through the domain's own options schema rather than field by field — that is
  // what keeps this list and `listStock`'s contract from drifting apart. Garbage degrades
  // rather than throws, and not only because the schema is lenient: every field is an
  // *optional string*, so `?location=not-a-real-id` parses cleanly and yields an empty
  // list, while `parseInput` would have thrown a 422 on a shape the schema cannot produce.
  const options = parseInput(stockListOptionsSchema, {
    locationId: url.searchParams.get("location") ?? undefined,
    // The supplier filter. `stockListOptionsSchema` already had
    // `vendorId` - it was unreachable from the URL because nothing read the parameter,
    // which is the "a URL parameter that lies" defect this file already names for
    // `hideUnassigned`. It is wired now, and it is wired the same way as `location`.
    vendorId: url.searchParams.get("vendor") ?? undefined,
    search: url.searchParams.get("q") ?? undefined,
    // `hideUnassigned` now filters with OR without a location
    // `listStock` gained the missing unfiltered branch, so the param and the
    // checkbox below do what they say.
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
    items,
    locations,
    vendors,
    filters: {
      locationId: options.locationId ?? "",
      vendorId: options.vendorId ?? "",
      search: options.search ?? "",
      includeUnassigned: options.includeUnassigned,
    },
  };
}

export default function StockIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const columns = React.useMemo(() => stockColumns(t), [t]);
  const { items, locations, vendors, filters } = loaderData;
  const autoSubmit = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
    e.currentTarget.form?.requestSubmit();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl">{t("inventory.stock.list.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("inventory.stock.list.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {/* Equipment keeps its own page: `/inventory` and `/inventory/:id` still mean
              `Equipment`. Cross-linking the two namespaces is what makes that split
              legible from either side. */}
          <Button asChild variant="outline">
            <Link to="/inventory">{t("inventory.stock.list.devices")}</Link>
          </Button>
          <Button asChild>
            <Link to="/inventory/stock/new">{t("inventory.stock.list.new")}</Link>
          </Button>
        </div>
      </div>

      <Form method="get" className="flex flex-wrap items-center gap-3">
        <Input
          name="q"
          defaultValue={filters.search}
          placeholder={t("inventory.stock.list.searchPlaceholder")}
          className="max-w-[16rem]"
          aria-label={t("inventory.stock.list.searchLabel")}
        />
        {/* The supplier filter, shaped exactly like the location one above it: same
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
        <Button type="submit" variant="outline" size="sm">
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

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
