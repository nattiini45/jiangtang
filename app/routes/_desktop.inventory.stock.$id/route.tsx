import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { formDataToObject, safeParse, tagsFromForm } from "~/lib/validation.server";
import { t } from "~/i18n";
import { tr } from "~/i18n/request-locale.server";
import { resolveLocale } from "~/i18n/locale.server";
import { listLocationTree } from "~/domains/locations/locations.tree.server";
import { listVendors } from "~/domains/vendors/vendors.queries.server";
import {
  getStockItemWithRefs,
  requireStockItem,
} from "~/domains/inventory/inventory.stock.queries.server";
import {
  deleteStockItem,
  updateStockItem,
} from "~/domains/inventory/inventory.stock.mutations.server";
import { stockEditSchema } from "~/domains/inventory/inventory.stock.schema";
import { DateCell } from "~/components/data-grid";
import { ZodForm } from "~/components/forms";
import { StockFormFields } from "~/components/inventory/stock-form-fields";
import { StockFormErrors } from "~/components/inventory/stock-form-errors";
import { stockStatusLabel } from "~/components/inventory/labels";
import { Button } from "~/components/ui/button";
import { metaLocale } from "~/i18n/meta";
import { useLocale, useT } from "~/i18n/use-t";
import { StockModelLink } from "~/components/inventory/parts";
import { partModelOptions } from "~/domains/inventory/inventory.parts.queries.server";
import { linkStockModel } from "~/domains/inventory/inventory.parts.mutations.server";

/**
 * `/inventory/stock/:id` — one stock item, and the **full editor** for it.
 *
 * **The linked `Equipment` and the warranty date are both on this page.**
 * The equipment link points at `/inventory/:id`, which is what that URL means.
 *
 * ### Why this page is a full editor
 *
 * A half-editor is a trap: `stockEditSchema` extends the create schema, so every field a
 * form omits is rewritten from its default, and `stockData()` writes
 * `input.tags ?? []` — a form with no tags control silently clears the tag list on every
 * save. Carrying the untouched fields from the row avoids that, but a page that showed the
 * other fields read-only would still leave a user unable to correct a typo in a SKU, a
 * wrong category, or a wrong purchase date at all, with only the create form or SQL as a
 * way out. So this page owns every field it can edit, and the per-field save assertion in
 * `test/routes/inventory-stock-routes.test.ts` is what makes owning them safe.
 *
 * ⚠️ **`_action` is `save` / `delete` rather than `move`, and "move" is just a save
 * that changed `locationId`.** The old value is still accepted, so a stale form in a cached
 * tab keeps working instead of erroring — the one thing a rename must not break.
 *
 * ### The one field this form does not own: `equipmentId`
 *
 * The harmony link is written by the stock-mutation domain, not this form: it emits two
 * audit rows, so it cannot share the form's single-row writer. This form therefore renders
 * no control for the field and the action **carries** the row's value — the same
 * `form.has(...)` discipline it applies to `vendorId`, generalised: *a field the form did
 * not submit is carried; a field it did submit is taken from it.* It is what makes a
 * partial client harmless rather than destructive.
 */

/** The action's intents. `move` is the older name and is still accepted. */
const SAVE_ACTIONS = new Set(["save", "move", ""]);

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "inventory.meta.titled", {
        name: data?.item.name ?? t(locale, "inventory.meta.stockFallback"),
      }),
    },
  ];
}

/** The two actions, so a test cannot assert a string the component does not render. */
export const STOCK_ITEM_INTENTS = { save: "save", delete: "delete" } as const;

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const item = await getStockItemWithRefs(params.id);
  if (!item) throw toErrorResponse(new NotFoundError(tr("err.stockItem.notFound")));
  const [locations, vendors] = await Promise.all([listLocationTree(), listVendors()]);
  return {
    item: { ...item, purchasePrice: item.purchasePrice ? item.purchasePrice.toString() : null },
    locations,
    vendors,
    partOptions: await partModelOptions("", item.modelId),
  };
}

/**
 * ⚠️ **The row type is DERIVED from the query rather than imported.** Naming
 * `~/generated/prisma/client` here would be a *type-only* import — erased at compile time,
 * no database handle — and the structural test bans that specifier in a route because the
 * ban's reason is the handle, not the name. Rather than widen the ban to "except when it is
 * `import type`", `Awaited<ReturnType<typeof requireStockItem>>` gives the type, stays in
 * sync with the call that produces it, and keeps the route's imports clean. It is the PLAIN
 * row, with no relations: the action has no use for a join it would only throw away.
 */
type StockItemRow = Awaited<ReturnType<typeof requireStockItem>>;

/**
 * Build the edit input: the row as the base, the form as the override.
 *
 * ⚠️ **The rule is one sentence: a field the form SUBMITTED wins; a field it did not is
 * CARRIED from the row.** That is the `form.has("vendorId")` discipline generalised to
 * every field, and it is what lets one form own thirteen fields while a stale or partial
 * client stays harmless — the old failure was a *missing* key being written as a default,
 * and "missing ⇒ carry" is the only reading that fixes it.
 *
 * `Decimal → string` because the schema validates the *string* with a money regex and hands
 * it to Prisma untouched; the Decimal object would fail that regex.
 *
 * ⚠️ **The key set is read from the row, not from a hand-written list.** A list would be one
 * more place to forget a column the day the schema grows; `EDITED_FIELDS` is asserted against
 * `stockEditSchema`'s own shape keys in the test, so a new field cannot be added to the
 * schema without this function either picking it up or failing loudly.
 */
const EDITED_FIELDS = [
  "name",
  "sku",
  "serial",
  "quantity",
  "unit",
  "category",
  "status",
  "purchasedAt",
  "purchasePrice",
  "warrantyExpiresAt",
  "vendorId",
  "locationId",
  "tags",
] as const;

function editInputFrom(item: StockItemRow, form: FormData): Record<string, unknown> {
  const raw = formDataToObject(form);
  const carried: Record<string, unknown> = {
    id: item.id,
    // `equipmentId` belongs to the harmony link, which the stock-mutation domain writes,
    // and this form renders no control for it, so the row's value is carried. See the
    // file header.
    equipmentId: item.equipmentId ?? undefined,
  };
  for (const field of EDITED_FIELDS) {
    if (field === "tags") continue;
    // `has()`, not `??`: a key present with "" means the user cleared the field (a real
    // state — take it), and a key ABSENT means this form never offered the control (carry
    // the row). `??` collapses those two into "cleared", which is the data-loss bug.
    carried[field] = form.has(field)
      ? raw[field]
      : field === "purchasePrice" && item.purchasePrice
        ? item.purchasePrice.toString()
        : (item[field] ?? undefined);
  }
  carried.tags = tagsFromForm(form, item.tags);
  return carried;
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "save");
  if (intent === "linkStockModel") {
    try {
      const modelId = String(form.get("modelId") ?? "");
      await linkStockModel(actor, params.id, modelId === "none" ? null : modelId);
      return { partsSaved: true };
    } catch (error) {
      if (error instanceof ValidationError)
        return {
          partsError: [...Object.values(error.fieldErrors).flat(), ...error.formErrors].join(" "),
        };
      throw toErrorResponse(error);
    }
  }
  try {
    if (intent === STOCK_ITEM_INTENTS.delete) {
      // Refused inline while the item is linked to an Equipment, mirroring the `Restrict`
      // foreign key. Detaching goes through the harmony link's own write path.
      await deleteStockItem(actor, params.id);
      await emitChange({ entityType: "inventory-item", id: params.id, op: "deleted" });
      return redirect("/inventory/stock");
    }
    if (!SAVE_ACTIONS.has(intent)) {
      // An unknown intent is a refusal, not a save. Falling through would let a typo in a
      // hidden field write a row.
      return { fieldErrors: {}, formErrors: [t(locale, "err.unknownAction")] };
    }
    const before = await requireStockItem(params.id);
    // 🔴 The form is parsed through the REAL `stockEditSchema`, not hand-assembled.
    // The schema is the field contract (`optionalText`, the money regex, a blank
    // `quantity` ⇒ 1), and a save that bypassed it would accept a negative quantity, a
    // malformed price, or a quantity of `NaN` — all of which the create path already
    // refuses, and a stock row is a stock row whichever form wrote it.
    const result = safeParse(stockEditSchema, editInputFrom(before, form), locale);
    // ⚠️ BOTH channels, always (see `stock-form-errors.tsx`).
    if (!result.success) return { fieldErrors: result.fieldErrors, formErrors: result.formErrors };
    const item = await updateStockItem(actor, params.id, result.data);
    await emitChange({ entityType: "inventory-item", id: item.id, op: "updated" });
    return redirect(`/inventory/stock/${item.id}`);
  } catch (e) {
    // ⚠️ BOTH channels. `deleteStockItem`'s refusal is a `formErrors` message ("linked
    // stock is not deleted"), so returning `fieldErrors` alone would render it as
    // silence next to a button that did nothing.
    if (e instanceof ValidationError)
      return { fieldErrors: e.fieldErrors, formErrors: e.formErrors };
    throw toErrorResponse(e);
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

const dash = <span className="text-muted-foreground">—</span>;

/** `Date | null` → the `yyyy-mm-dd` an `<input type="date">` needs, in Europe/Berlin. */
function dateInputValue(d: Date | null | undefined): string | null {
  if (!d) return null;
  // ⚠️ `en-CA` is the ISO-shaped `yyyy-mm-dd` locale, and the timeZone is pinned: without
  // it a UTC-midnight date renders as the PREVIOUS day in a Berlin-local browser, which
  // would silently move a warranty date on every edit.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(d);
}

export default function StockItemDetail({ loaderData, actionData }: Route.ComponentProps) {
  const locale = useLocale();
  const t = useT();
  const { item, locations, vendors } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const linked = Boolean(item.equipmentId);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-xl font-bold">{item.name}</h1>
        <Link to="/inventory/stock" className="text-muted-foreground text-sm hover:underline">
          {t("inventory.stock.detail.back")}
        </Link>
      </div>

      <section className="bg-card shadow-surface-2 grid grid-cols-2 gap-4 rounded-lg p-4 sm:grid-cols-3">
        {item.model ? (
          <Field label={t("parts.partModel")}>
            <Link
              className="break-words underline underline-offset-4"
              to={`/inventory/models/${item.model.id}`}
            >
              {item.model.manufacturer} {item.model.name}
            </Link>
          </Field>
        ) : null}
        <Field label={t("inventory.stock.form.quantity")}>
          <span className="nums">{`${item.quantity}${item.unit ? ` ${item.unit}` : ""}`}</span>
        </Field>
        <Field label={t("inventory.stock.form.sku")}>
          {item.sku ? <span className="font-mono">{item.sku}</span> : dash}
        </Field>
        <Field label={t("inventory.stock.form.serial")}>
          {item.serial ? <span className="font-mono">{item.serial}</span> : dash}
        </Field>
        <Field label={t("inventory.stock.form.category")}>{item.category ?? dash}</Field>
        <Field label={t("inventory.stock.form.status")}>
          {item.status ? stockStatusLabel(locale, item.status) : dash}
        </Field>
        <Field label={t("inventory.stock.form.vendor")}>
          {item.vendor ? item.vendor.name : dash}
        </Field>
        <Field label={t("inventory.stock.form.price")}>
          <span className="nums">{item.purchasePrice ?? dash}</span>
        </Field>
        <Field label={t("inventory.stock.form.purchasedAt")}>
          <DateCell value={item.purchasedAt} withTime={false} />
        </Field>
        {/* The warranty date is on the item's own page, not only in a column. The expiry
            sweep owns deciding what "expiring" means — this page states the date and no
            verdict, so the two can never disagree. */}
        <Field label={t("inventory.stock.form.warranty")}>
          <DateCell value={item.warrantyExpiresAt} withTime={false} />
        </Field>
      </section>
      <StockModelLink stockId={item.id} modelId={item.modelId} options={loaderData.partOptions} />

      <section className="bg-card shadow-surface-2 flex flex-col gap-3 rounded-lg p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">{t("inventory.stock.detail.device")}</h2>
          {item.equipment ? (
            <Link to={`/inventory/${item.equipment.id}`} className="text-sm hover:underline">
              {item.equipment.name ?? item.equipment.assetTag ?? item.equipment.id}
            </Link>
          ) : (
            <span className="text-muted-foreground text-sm">
              {t("inventory.stock.detail.notLinked")}
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-xs">{t("inventory.stock.detail.linkNote")}</p>
      </section>

      {/* 🔴 One form owns every field it can edit. `StockFormFields` is the SAME
          component the create form uses, which is the point — two hand-written field lists
          would drift, and the drift would show up as a field this page silently stops
          editing. */}
      <ZodForm
        method="post"
        fieldErrors={actionData?.fieldErrors}
        className="bg-card shadow-surface-2 flex flex-col gap-3 rounded-lg p-4"
      >
        <input type="hidden" name="_action" value={STOCK_ITEM_INTENTS.save} />
        <StockFormErrors formErrors={actionData?.formErrors} />
        <StockFormFields
          locations={locations}
          vendors={vendors}
          defaults={{
            name: item.name,
            sku: item.sku,
            serial: item.serial,
            quantity: item.quantity,
            unit: item.unit,
            category: item.category,
            status: item.status,
            purchasedAt: dateInputValue(item.purchasedAt),
            purchasePrice: item.purchasePrice,
            warrantyExpiresAt: dateInputValue(item.warrantyExpiresAt),
            locationId: item.locationId,
            vendorId: item.vendorId,
            // ⚠️ ALWAYS passed, unlike on the create form: this form owns `tags`, so the
            // route must never fall into the carry branch for it. `[]` for an untagged row
            // is the honest default and renders one empty box.
            tags: item.tags,
          }}
        />
        <div>
          <Button type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("inventory.stock.detail.submit")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t("inventory.stock.detail.moveNote")}</p>
      </ZodForm>

      <Form
        method="post"
        className="flex flex-col gap-3 border-t pt-4"
        onSubmit={(e) => {
          if (!confirm(t("inventory.stock.detail.confirmDelete", { name: item.name })))
            e.preventDefault();
        }}
      >
        <input type="hidden" name="_action" value={STOCK_ITEM_INTENTS.delete} />
        <Button type="submit" variant="destructive" disabled={busy || linked}>
          {t("inventory.stock.detail.delete")}
        </Button>
        <p className="text-muted-foreground mt-1 text-xs">
          {linked
            ? t("inventory.stock.detail.deleteLinked")
            : t("inventory.stock.detail.deleteHint")}
        </p>
      </Form>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
