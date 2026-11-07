import { Link } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { NotFoundError, toErrorResponse } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { getStockItemWithRefs } from "~/domains/inventory/inventory.stock.queries.server";
import { listAttachments } from "~/domains/attachments/attachments.queries.server";
import { kindLabel } from "~/components/locations/labels";
import { StockStatusText } from "~/components/i18n/enum-text";
import { berlinDateInput } from "~/lib/format-date";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Mobile stock item detail — quantities, SKU/serial, location, vendor, linked
 * device, and the item's attachments (thumbnails tap through to the full file).
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "mobile.meta.stockDetail") }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const item = await getStockItemWithRefs(params.id!);
  if (!item) throw toErrorResponse(new NotFoundError(tr("err.notFoundBody")));
  // Attachments hang off the linked equipment unit when there is one.
  const attachments = item.equipment
    ? await listAttachments({ equipmentId: item.equipment.id })
    : [];
  return { item, attachments };
}

export default function MobileStockDetail({ loaderData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { item, attachments } = loaderData;
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{item.name}</h1>
        <Link to="/m/inventory/stock" className="text-muted-foreground text-sm hover:underline">
          {t("mobile.stockDetail.back")}
        </Link>
      </div>

      <dl className="bg-card shadow-surface-2 divide-y overflow-hidden rounded-lg text-sm">
        {(
          [
            [
              t("inventory.stock.col.quantity"),
              `${item.quantity}${item.unit ? ` ${item.unit}` : ""}`,
            ],
            [t("inventory.stock.col.sku"), item.sku],
            [t("inventory.stock.col.serial"), item.serial],
            [
              t("inventory.stock.col.location"),
              item.location
                ? `${item.location.name} · ${kindLabel(locale, item.location.kind)}`
                : null,
            ],
            [t("inventory.stock.col.vendor"), item.vendor?.name ?? null],
            [
              t("inventory.stock.col.device"),
              item.equipment ? (
                <Link to={`/inventory/${item.equipment.id}`} className="hover:underline">
                  {item.equipment.name ?? item.equipment.assetTag ?? item.equipment.id}
                </Link>
              ) : null,
            ],
            [
              t("inventory.stock.col.status"),
              item.status ? <StockStatusText value={item.status} /> : null,
            ],
            [
              t("inventory.stock.col.warranty"),
              item.warrantyExpiresAt ? berlinDateInput(item.warrantyExpiresAt) : null,
            ],
          ] as [string, React.ReactNode][]
        ).map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4 px-3 py-2">
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="text-right">
              {value ?? <span className="text-muted-foreground">—</span>}
            </dd>
          </div>
        ))}
      </dl>

      {attachments.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">{t("mobile.stockDetail.attachments")}</h2>
          <div className="flex flex-wrap gap-2">
            {attachments.map((a) => (
              <a key={a.id} href={`/attachments/${a.objectKey}`}>
                <img
                  src={`/attachments/${a.objectKey}?thumb=1`}
                  alt={a.filename}
                  className="size-20 rounded-md object-cover"
                />
              </a>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
