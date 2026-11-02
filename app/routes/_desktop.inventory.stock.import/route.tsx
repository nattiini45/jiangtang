import { Link, redirect } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { previewCsv } from "~/lib/csv/preview";
import { stockCreateSchema } from "~/domains/inventory/inventory.stock.schema";
import { bulkCreateStock } from "~/domains/inventory/inventory.stock.import.server";
import { CsvImportPanel } from "~/components/rooms/csv-import-panel";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";
import { STOCK_STATUS_ALIASES } from "~/lib/status";

/**
 * `/inventory/stock/import` — bulk stock ingest.
 *
 * **The Equipment importer's shape** — paste, preview, commit — with two
 * deliberate differences, both of them the row's criteria rather than taste:
 *
 * 1. **Validation is `previewCsv` + `stockCreateSchema`**, not a CSV-specific row
 *    schema. The Equipment side needs `equipmentCsvRowSchema` because its columns
 *    are German words that have to be *translated* (`kategorie` → `category`) and
 *    because `modell`/`raum` are resolved against the database. Here the columns
 *    **are** the schema's field names, so a second schema could only disagree with
 *    the first — and the one thing the import must not do is validate somewhere
 *    other than the form's own schema, which is how the blank-`quantity` rule
 *    would have been bypassed on the very path that motivated it.
 * 2. **A file with any invalid row cannot be committed at all.** The Equipment
 *    route commits `preview.valid` and ignores `preview.invalid` — a partial
 *    import. Criterion (3) is all-or-nothing per file, so the refusal below names
 *    the first bad line and the user fixes the file rather than importing the
 *    rows that happened to be clean.
 */

/** The columns, in the schema's own order. `tags` is deliberately absent — see below. */
const HEADER =
  "name,sku,serial,quantity,category,status,unit,purchasedAt,purchasePrice,warrantyExpiresAt,vendorId,locationId,equipmentId";
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "inventory.meta.stockImport") }];
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const obj = formDataToObject(await request.formData());
  const intent = String(obj._action ?? "preview");
  const csv = String(obj.csv ?? "");
  const preview = previewCsv(csv, stockCreateSchema, locale);
  const view = {
    validCount: preview.valid.length,
    invalid: preview.invalid.map(({ line, messages }) => ({ line, messages })),
  };

  if (intent === "commit") {
    // Criterion (3): all-or-nothing. Naming the FIRST bad line is deliberate — a
    // 30-row file with 12 bad lines gets one place to start, and the full list is
    // still rendered by the panel below.
    if (preview.invalid.length > 0) {
      const first = preview.invalid[0];
      return {
        csv,
        preview: view,
        error: t(locale, "err.import.aborted", {
          count: preview.invalid.length,
          line: first.line,
          messages: first.messages.join("; "),
        }),
      };
    }
    if (preview.valid.length === 0)
      return { csv, preview: view, error: t(locale, "err.import.noValidRows") };
    try {
      await bulkCreateStock(actor, preview.valid);
      // One event for the file, not one per row: clients refetch on reconnect
      // (real-time is an accelerator, not the truth), and a 30-row import is 30
      // NOTIFYs nobody asked for.
      await emitChange({ entityType: "inventory-item", id: "bulk", op: "created" });
      return redirect("/inventory/stock");
    } catch (e) {
      if (e instanceof ValidationError) {
        return {
          csv,
          preview: view,
          error: Object.values(e.fieldErrors).flat().concat(e.formErrors).join("; "),
        };
      }
      throw toErrorResponse(e);
    }
  }
  return { csv, preview: view };
}

export default function StockImport({ actionData }: Route.ComponentProps) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-bold">{t("inventory.stockImport.title")}</h1>
        <Link to="/inventory/stock" className="text-muted-foreground text-sm hover:underline">
          {t("inventory.stockImport.back")}
        </Link>
      </div>
      <CsvImportPanel
        description={t("inventory.stockImport.description", {
          statuses: STOCK_STATUS_ALIASES.labels(locale).join(" · "),
        })}
        headerLine={HEADER}
        sampleRow={t("inventory.stockImport.sample")}
        actionData={actionData}
      />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
