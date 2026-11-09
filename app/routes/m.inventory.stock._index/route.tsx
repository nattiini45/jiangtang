import { Form, Link } from "react-router";
import { EmptyState } from "~/components/states/empty-state";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Button } from "~/components/ui/button";
import { Package } from "lucide-react";
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
 * read path. `requireUser` is called here, as in every route: a single-fetch request can
 * run this loader without the `m` layout's.
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
  return {
    items: await listStock(options),
    q: options.search ?? "",
    hideUnassigned: url.searchParams.get("hideUnassigned") === "1",
  };
}

export default function MobileStockIndex({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { items, q, hideUnassigned } = loaderData;
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <h1 className="text-lg font-semibold">{t("nav.stock")}</h1>
      <Form method="get" className="flex flex-col gap-2">
        <Label htmlFor="stock-search">{t("mobile.stock.search")}</Label>
        {hideUnassigned ? <input type="hidden" name="hideUnassigned" value="1" /> : null}
        <div className="flex gap-2">
          <Input
            key={q}
            id="stock-search"
            type="search"
            name="q"
            defaultValue={q}
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="secondary">
            {t("nav.search")}
          </Button>
        </div>
      </Form>
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
                to={`/m/inventory/stock/${item.id}`}
                className="active:bg-selected flex min-h-12 items-center gap-3 px-3 py-2 transition-colors duration-80"
              >
                <div className="min-w-0 flex-1">
                  <p className="whitespace-normal text-sm font-semibold">{item.name}</p>
                  <p className="text-muted-foreground nums whitespace-normal text-xs">
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
          <li>
            <EmptyState
              icon={Package}
              title={t(q || hideUnassigned ? "mobile.filters.emptyTitle" : "mobile.stock.empty")}
              hint={t(q || hideUnassigned ? "mobile.filters.emptyHint" : "mobile.stock.emptyHint")}
              action={
                q || hideUnassigned
                  ? { to: "/m/inventory/stock", label: t("mobile.filters.clear") }
                  : undefined
              }
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export { MobileRouteErrorBoundary as ErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
