import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listLocationTree } from "~/domains/locations/locations.tree.server";
import { kindLabel } from "~/components/locations/labels";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/m/locations` — the location tree on the phone (read-only).
 *
 * **No `action` export, deliberately.** Capture flows on mobile are task, note
 * and ticket triage; a location created on a phone is a location created
 * somewhere you can see the tree, and this surface's own job is to answer
 * "where is this thing". The absence is load-bearing rather than incidental, so
 * `test/routes/locations-routes.test.ts` asserts the export is *missing* —
 * adding one later has to update a test that names the reason.
 *
 * Same `listLocationTree` module as the desktop surface: one query, two
 * renderings, no forked read path.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "locations.meta.list") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  return { nodes: await listLocationTree() };
}

export default function MobileLocationsIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { nodes } = loaderData;
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <h1 className="text-lg font-semibold">{t("nav.locations")}</h1>
      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {nodes.map((node) => (
          <li key={node.id}>
            <Link
              to={`/locations/${node.id}`}
              className="active:bg-selected flex min-h-12 items-center gap-3 px-3 py-2 transition-colors duration-80"
              // Same real hierarchy depth the desktop tree draws — a filtered or
              // mobile list must not flatten a parent into its own child.
              style={{ paddingLeft: `${0.75 + node.depth * 0.75}rem` }}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{node.name}</p>
                <p className="text-muted-foreground nums text-xs">
                  {node.code ? <span className="font-mono">{node.code}</span> : null}
                  {node.code ? " · " : null}
                  {kindLabel(locale, node.kind) || (node.code ? null : "—")}
                </p>
              </div>
            </Link>
          </li>
        ))}
        {nodes.length === 0 ? (
          <li className="text-muted-foreground px-3 py-4 text-sm">{t("mobile.locations.empty")}</li>
        ) : null}
      </ul>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
