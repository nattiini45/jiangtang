import { Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse, tagsFromForm } from "~/lib/validation.server";
import { resolveLocale } from "~/i18n/locale.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { listLocationTree } from "~/domains/locations/locations.tree.server";
import { listVendors } from "~/domains/vendors/vendors.queries.server";
import { stockCreateSchema } from "~/domains/inventory/inventory.stock.schema";
import { createStockItem } from "~/domains/inventory/inventory.stock.mutations.server";
import { ZodForm } from "~/components/forms";
import { StockFormFields } from "~/components/inventory/stock-form-fields";
import { StockFormErrors } from "~/components/inventory/stock-form-errors";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * `/inventory/stock/new` — create a stock item.
 *
 * **The write goes through `createStockItem`, so the `ActivityLog` row commits with the
 * item or not at all (`txWithAudit`)** — a route that wrote stock directly would break the
 * audit spine that `guards.sh` #2 exists to protect.
 *
 * **A duplicate `sku`/`serial` is a field error, not a 500.** The uniqueness lives in the
 * DATABASE, so the violation arrives from Postgres after the statement is issued and
 * the domain's job is to translate it — `createStockItem` does, and the `ValidationError`
 * branch below is what turns that into something renderable next to the input.
 *
 * ### `tags` — why this action does NOT go through `safeParseForm`
 *
 * `safeParseForm(request, schema)` reads the body itself, and **a request body reads ONCE**.
 * Normalising `tags` needs the `FormData`, so the body is read here, converted once, and
 * `tags` replaced before `safeParse` — the exact shape the edit route already uses
 * (`_desktop.inventory.stock.$id/route.tsx:151` + `:173-176`). An implementation that kept
 * `safeParseForm` and then called `request.formData()` would read the body a second time and
 * get an empty one, which is a silently empty tag list rather than an error.
 *
 * 🔴 **A create form sends EXACTLY ONE `tags` input.** `stock-form-fields.tsx` renders one
 * box per entry plus one spare and has deliberately no "add tag" button, so an untouched form
 * posts a single `"kabel"` — a **bare string**, which `stockCreateSchema.tags`
 * (`z.array(...).default([])`) rejects as *"Invalid input: expected array, received string"*.
 * Measured through the real `formDataToObject` + the real `stockCreateSchema`: `""`,
 * `"kabel"` and `"   "` are all bare strings, all three fail identically. `tagsFromForm` is
 * what turns them into `[]` / `["kabel"]` / `[]`.
 *
 * ⚠️ **`tagsFromForm` normalises in the ROUTE, never in the schema.** The schema is shared
 * with the CSV importer, and a coercion there would make the importer accept a
 * `tags` column — reversing a shipped decision the UI states in words. See
 * `app/lib/validation.server.ts` for the full argument; it is the reason the rule lives
 * where a `FormData` exists.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "inventory.meta.stockNew") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  // `?location=` preselects a location — the flow a warehouse actually has ("put this
  // away in the store"), and the same affordance `locations/new?parent=` established.
  // A stale id is simply not among the options, so it cannot be silently submitted.
  const url = new URL(request.url);
  // 🔴 `Promise.all`, not two awaits: the two lists are independent reads, and the
  // locations walk is a recursive CTE while the vendors query is a flat `findMany`.
  const [locations, vendors] = await Promise.all([listLocationTree(), listVendors()]);
  const requested = url.searchParams.get("location");
  return {
    locations,
    vendors,
    defaultLocationId: locations.some((l) => l.id === requested) ? requested : null,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  // 🔴 The body is read ONCE, here, and `tags` is normalised before the schema sees
  // it. See the file header — `safeParseForm` cannot be used on this path.
  const form = await request.formData();
  const input = formDataToObject(form);
  input.tags = tagsFromForm(form, []);
  const result = safeParse(stockCreateSchema, input, resolveLocale(request));
  // ⚠️ BOTH channels, always. `formErrors` is where a refusal that belongs to no single
  // field lands; returning `fieldErrors` alone renders it as silence.
  if (!result.success) return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
  try {
    const item = await createStockItem(actor, result.data);
    await emitChange({ entityType: "inventory-item", id: item.id, op: "created" });
    return redirect(`/inventory/stock/${item.id}`);
  } catch (e) {
    if (e instanceof ValidationError)
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    throw toErrorResponse(e);
  }
}

export default function NewStockItem({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const { locations, vendors, defaultLocationId } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-bold">{t("inventory.stock.new.title")}</h1>
        <Link to="/inventory/stock" className="text-muted-foreground text-sm hover:underline">
          {t("inventory.stock.new.back")}
        </Link>
      </div>
      <ZodForm method="post" fieldErrors={actionData?.fieldErrors}>
        <StockFormErrors formErrors={actionData?.formErrors} />
        <StockFormFields
          locations={locations}
          vendors={vendors}
          // 🔴 `tags: []` is LOAD-BEARING, not a default. `StockFormFields` reads
          // `undefined` and `[]` as two different statements — `undefined` means "this form
          // does not own the field" and the route then carries the row's value, `[]` means
          // "this form owns the field and it is empty". Omitting it here is what left the
          // create form with no tag control at all.
          defaults={{ ...(defaultLocationId ? { locationId: defaultLocationId } : {}), tags: [] }}
        />
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.creating") : t("inventory.stock.new.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/inventory/stock">{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
