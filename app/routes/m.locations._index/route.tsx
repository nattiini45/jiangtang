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
    <div className="flex flex-col">
      <div className="border-border border-b px-4 py-3">
        <h1 className="font-mono text-lg">{t("nav.locations")}</h1>
      </div>
      <ul className="divide-border divide-y">
        {nodes.map((node) => (
          <li key={node.id}>
            <Link
              to={`/locations/${node.id}`}
              className="active:bg-accent flex items-center gap-3 px-4 py-3"
              // Same real hierarchy depth the desktop tree draws — a filtered or
              // mobile list must not flatten a parent into its own child.
              style={{ paddingLeft: `${1 + node.depth * 0.75}rem` }}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-base">{node.name}</p>
                <p className="text-muted-foreground font-mono text-xs">
                  {[node.code, kindLabel(locale, node.kind)].filter(Boolean).join(" · ") || "—"}
                </p>
              </div>
            </Link>
          </li>
        ))}
        {nodes.length === 0 ? (
          <li className="text-muted-foreground p-4 text-sm">{t("mobile.locations.empty")}</li>
        ) : null}
      </ul>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
