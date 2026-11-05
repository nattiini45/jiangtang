import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { parseEnumParam } from "~/lib/validation.server";
import { LocationKind } from "~/generated/prisma/enums";
import { listLocationTree } from "~/domains/locations/locations.tree.server";
import { Button } from "~/components/ui/button";
import { LocationTree } from "~/components/locations/location-tree";
import { LocationKindFilter } from "~/components/locations/location-kind-filter";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/locations` — the location spine, all kinds.
 *
 * **The `kind` filter lives in the URL and nowhere else.** The loader reads
 * `?kind=`, validates it against the generated enum with `parseEnumParam`, and
 * returns the accepted value as `kind` so the component can highlight it — a
 * copied link therefore reproduces the view, and a garbage value degrades to
 * the unfiltered list rather than throwing (the `list-filter-parsing.test.ts`
 * contract, reused here because a hostile query string is a hostile query
 * string on every list page).
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "locations.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const kind = parseEnumParam(LocationKind, new URL(request.url).searchParams.get("kind"));
  return { nodes: await listLocationTree(kind ? { kind } : {}), kind: kind ?? "" };
}

export default function LocationsIndex({ loaderData }: Route.ComponentProps) {
  const t = useT();
  const { nodes, kind } = loaderData;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">{t("locations.list.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("locations.list.subtitle")}</p>
        </div>
        <Button asChild>
          <Link to="/locations/new">{t("locations.list.new")}</Link>
        </Button>
      </div>

      <LocationKindFilter active={kind} />

      <LocationTree
        nodes={nodes}
        emptyMessage={kind ? t("locations.list.emptyFiltered") : t("locations.list.empty")}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
