import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listModels } from "~/domains/catalog/catalog.queries.server";
import { DataGrid } from "~/components/data-grid";
import { modelColumns } from "~/components/inventory/model-columns";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";
import * as React from "react";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "inventory.meta.models") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return { models: await listModels() };
}

export default function ModelCatalog({ loaderData }: Route.ComponentProps) {
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
        columns={columns}
        data={loaderData.models}
        getRowId={(m) => m.id}
        emptyMessage={t("inventory.models.empty")}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
