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
 * Criterion (3) names it, so `test/routes/inventory-stock-routes.test.ts` checks the
 * export is *missing*: adding one later has to update a test that states the reason, which
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
    <div className="flex flex-col gap-4 px-4 py-4">
      <h1 className="text-lg font-semibold">{t("nav.stock")}</h1>
      <ul className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg">
        {items.map((item) => {
          const quantity = `${item.quantity}${item.unit ? ` ${item.unit}` : ""}`;
          const location = item.location
            ? `${item.location.name} (${kindLabel(locale, item.location.kind)})`
            : t("mobile.stock.unassigned");
          const status = item.status ? stockStatusLabel(locale, item.status) : null;
          // Serial numbers and SKUs are identifiers, so only they keep the mono face.
          const identifier = item.serial ?? item.sku;
          return (
            <li key={item.id}>
              <Link
                to={`/inventory/stock/${item.id}`}
                className="active:bg-selected flex min-h-12 items-center gap-3 px-3 py-2 transition-colors duration-80"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{item.name}</p>
                  <p className="text-muted-foreground nums truncate text-xs">
                    {[quantity, location, status].filter(Boolean).join(" · ")}
                    {identifier ? (
                      <>
                        {" · "}
                        <span className="font-mono">{identifier}</span>
                      </>
                    ) : null}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
        {items.length === 0 ? (
          <li className="text-muted-foreground px-3 py-4 text-sm">{t("mobile.stock.empty")}</li>
        ) : null}
      </ul>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
