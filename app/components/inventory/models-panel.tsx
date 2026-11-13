import { Link } from "react-router";
import * as React from "react";
import type { ModelListRow } from "~/domains/catalog/catalog.queries.server";
import { DataGrid } from "~/components/data-grid";
import { modelColumns } from "~/components/inventory/model-columns";
import { Button } from "~/components/ui/button";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * The model-catalog panel of the `/inventory` tabs. `/inventory/models` used to
 * be its own page; it now redirects to `/inventory?tab=models` and this renders.
 */
export function ModelsPanel({ models }: { models: ModelListRow[] }) {
  const t = useT();
  const locale = useLocale();
  const columns = React.useMemo(() => modelColumns(t, locale), [t, locale]);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("inventory.models.title")}</h1>
          <p className="text-muted-foreground mt-1">{t("inventory.models.subtitle")}</p>
        </div>
        <Button asChild>
          <Link to="/inventory/models/new">{t("inventory.models.new")}</Link>
        </Button>
      </div>
      <DataGrid
        tableId="models"
        growColumn="name"
        columns={columns}
        data={models}
        getRowId={(m) => m.id}
        emptyMessage={t("inventory.models.empty")}
      />
    </div>
  );
}
