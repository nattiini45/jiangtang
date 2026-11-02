import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { listStock } from "~/domains/inventory/inventory.stock.queries.server";
import { parseInput } from "~/lib/validation.server";
import { stockListOptionsSchema } from "~/domains/inventory/inventory.stock.schema";
import { kindLabel } from "~/components/locations/labels";
import { stockStatusLabel } from "~/components/inventory/labels";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/m/inventory/stock` — the stock list on the phone (read-only).
 *
 * **No `action` export, deliberately, and the absence is asserted.**
 * The route test in `test/routes/inventory-stock-routes.test.ts` checks that the export is
 * *missing*: adding one later has to update a test that states the reason, which
 * is what stops a "just add a quick move button" edit from arriving unremarked. The
 * precedent and the reasoning are `m.locations`' — capture flows on mobile are task, note
 * and ticket triage, and a warehouse move is done where the shelf is.
 *
 * **Same `listStock` module as the desktop surface**: one query, two renderings, no forked
 * read path. `requireUser` IS called here (unlike the `_desktop` routes) because the `m`
 * layout guards too, and the m.tickets precedent guards in the route as well — belt and
 * braces on the surface that leaves the building.
 *
 * Item links go to the **desktop** `/inventory/stock/:id`, exactly as `/m/locations` links
 * to `/locations/:id`: the phone answers "where is this thing", the desk does the work.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "inventory.meta.stock") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const url = new URL(request.url);
  const options = parseInput(stockListOptionsSchema, {
    search: url.searchParams.get("q") ?? undefined,
    includeUnassigned: url.searchParams.get("hideUnassigned") === "1" ? false : undefined,
  });
  return { items: await listStock(options) };
}

export default function MobileStockIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { items } = loaderData;
  return (
    <div className="flex flex-col">
      <div className="border-border border-b px-4 py-3">
        <h1 className="font-mono text-lg">{t("nav.stock")}</h1>
      </div>
      <ul className="divide-border divide-y">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              to={`/inventory/stock/${item.id}`}
              className="active:bg-accent flex items-center gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-base">{item.name}</p>
                <p className="text-muted-foreground font-mono text-xs">
                  {[
                    `${item.quantity}${item.unit ? ` ${item.unit}` : ""}`,
                    item.location
                      ? `${item.location.name} (${kindLabel(locale, item.location.kind)})`
                      : t("mobile.stock.unassigned"),
                    item.status ? stockStatusLabel(locale, item.status) : null,
                    item.serial ?? item.sku,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </p>
              </div>
            </Link>
          </li>
        ))}
        {items.length === 0 ? (
          <li className="text-muted-foreground p-4 text-sm">{t("mobile.stock.empty")}</li>
        ) : null}
      </ul>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
