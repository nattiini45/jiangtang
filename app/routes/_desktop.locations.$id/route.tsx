import { Link } from "react-router";
import type { Route } from "./+types/route";
import { NotFoundError, toErrorResponse } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { getLocation } from "~/domains/locations/locations.queries.server";
import { listLocationTree } from "~/domains/locations/locations.tree.server";
import { listStockAtLocation } from "~/domains/inventory/inventory.stock.queries.server";
import { listNotes } from "~/domains/notes/notes.queries.server";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { LocationTree } from "~/components/locations/location-tree";
import { LocationStock } from "~/components/locations/location-stock";
import { NoteList } from "~/components/notes/note-list";
import { LOCATION_KIND_BADGE_CLASS, kindLabel } from "~/components/locations/labels";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * `/locations/:id` — one node, **its descendants**, and the stock **at it**
 * ("Location tree, all kinds").
 *
 * `listLocationTree({ parentId })` **roots the walk AT** that node, so the node
 * itself comes back at depth 0 with the subtree below it. The node's own row is
 * already loaded by `getLocation`, so it is filtered out of the descendant list
 * rather than re-rendered as its own child — a comparison on `id` and not on
 * `depth`, so the two paths cannot drift apart.
 *
 * **The stock panel is this node only, and the panel says so** (the half
 * of the old requirement that needed an `InventoryItem` query the location pages could not
 * own). `listStockAtLocation` filters `locationId = this node`: a stocked
 * building whose rooms hold the stock is not "0 Artikel", and an item assigned
 * nowhere (`locationId` is `String?`, `onDelete: SetNull`) belongs to no
 * location's panel. Both exclusions are stated on the surface itself
 * (`location-stock.tsx`), because both wrong readings look correct on screen.
 *
 * **Two domain queries, one round trip, no transaction** — both are reads, and
 * `txWithAudit` is for writes only. The count the panel prints is
 * `stock.length`, the same array it draws; the module's own `countStockAtLocation`
 * takes a `Tx` a loader cannot obtain and has no caller, so using it would mean
 * the number and the rows come from two different queries.
 *
 * 🔴 This loader reaches for the **domain** query modules only. A route that
 * imports `~/lib/db.server` itself crosses a boundary no guard in
 * `scripts/guards.sh` can see. ⚠️ **The import-boundary net that asserts this
 * (`test/routes/locations-routes.test.ts:249`) cannot see a dynamic `import()`**
 * — it stays green with the banned module imported — so this
 * row's own test closes that hole over these two files.
 */
export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "locations.meta.detail", {
        name: data?.location.name ?? t(locale, "locations.meta.fallbackName"),
      }),
    },
  ];
}

export async function loader({ params }: Route.LoaderArgs) {
  const location = await getLocation(params.id);
  if (!location) throw toErrorResponse(new NotFoundError(tr("err.location.notFound")));
  const [tree, stock, notes] = await Promise.all([
    listLocationTree({ parentId: location.id }),
    listStockAtLocation(location.id),
    listNotes({ locationId: location.id }),
  ]);
  return { location, descendants: tree.filter((node) => node.id !== location.id), stock, notes };
}

export default function LocationDetail({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { location, descendants, stock, notes } = loaderData;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-muted-foreground text-sm">
            <Link to="/locations" className="hover:underline">
              {t("locations.detail.back")}
            </Link>
          </div>
          <h1 className="mt-1 flex items-center gap-2 font-mono text-xl">
            <span className="truncate">{location.name}</span>
            <Badge className={LOCATION_KIND_BADGE_CLASS[location.kind]}>
              {kindLabel(locale, location.kind)}
            </Badge>
          </h1>
          {location.code ? (
            <p className="text-muted-foreground font-mono text-xs">{location.code}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-2">
          <Button asChild variant="outline">
            <Link to={`/locations/new?parent=${location.id}`}>{t("locations.detail.child")}</Link>
          </Button>
          <Button asChild>
            <Link to={`/locations/${location.id}/edit`}>{t("locations.detail.edit")}</Link>
          </Button>
        </div>
      </div>

      <dl className="border-border bg-border grid gap-px border sm:grid-cols-2">
        <div className="bg-background px-3 py-2">
          <dt className="text-muted-foreground text-xs">{t("locations.detail.address")}</dt>
          <dd className="text-sm">{location.address || "—"}</dd>
        </div>
        <div className="bg-background px-3 py-2">
          <dt className="text-muted-foreground text-xs">{t("locations.detail.description")}</dt>
          <dd className="text-sm">{location.description || "—"}</dd>
        </div>
      </dl>

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-sm">
          {t("locations.detail.children")}{" "}
          <span className="text-muted-foreground">({descendants.length})</span>
        </h2>
        <LocationTree nodes={descendants} emptyMessage={t("locations.detail.childrenEmpty")} />
      </section>

      {/* Additive, and the only second owner of this file. The
          mobile surface deliberately does NOT grow it — read-only there by design
          (a panel on a phone is a separate question, not this
          row's). `locations-routes.test.ts` passes untouched. */}
      <LocationStock
        items={stock}
        locationId={location.id}
        hasDescendants={descendants.length > 0}
      />

      {/* Notes pinned to this node — this node only, like the stock
          panel above: a building's notes do not include its rooms' notes. */}
      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-sm">
          {t("locations.detail.notes")}{" "}
          <span className="text-muted-foreground">({notes.length})</span>
        </h2>
        <NoteList notes={notes} emptyMessage={t("locations.detail.notesEmpty")} />
        <Button asChild variant="outline" size="sm" className="self-start">
          <Link to={`/notes/new?location=${location.id}`}>{t("locations.detail.notesNew")}</Link>
        </Button>
      </section>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
