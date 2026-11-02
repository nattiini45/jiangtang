import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { kindLabel } from "~/components/locations/labels";
import { stockStatusLabel } from "~/components/inventory/labels";
import { StockStatus } from "~/generated/prisma/enums";
import { StockVendorSelect, type StockVendorSelectProps } from "./stock-vendor-select";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * The **create** and **edit** form fields for a stock item, beside the Equipment form's
 * own `equipment-form-fields.tsx` rather than inside it — the two families are separate
 * namespaces (`inventory.stock.*`), and the same reasoning `inventory.stock.schema.ts`
 * gives for re-declaring its own field shapes.
 *
 * ⚠️ **`equipmentId` is deliberately absent, and it is the ONE field this form does not
 * own.** The harmony link is written by `linkStockItemToEquipment` /
 * `unlinkStockItemFromEquipment` in `inventory.stock.mutations.server.ts`, which also own
 * the bidirectional read (`inventory.harmony.queries.server.ts`) and the cannot-dangle
 * test. The schema comment calls the field "settable here", so leaving it to that pair
 * costs nothing and keeps one owner for the link.
 *
 * 🔴 **`tags` needs no bespoke wire format, and that is measured rather than assumed.**
 * **Collapsing repeated keys is what PRODUCES the `String[]`** — `formDataToObject`'s own
 * docstring says so (`app/lib/validation.server.ts:42`) and `:48-51` builds
 * `[existing, v]`. One `<input name="tags">` per tag is the entire control, and no
 * comma-splitting wire format is needed: a convention with one caller is a convention the
 * second caller must guess.
 *
 * ✅ **`vendorId` is here, and it arrives as a required prop rather than being fetched
 * here.** The route lists vendors through `vendors.queries.server.ts`; a component that
 * called `listVendors()` itself would open a database handle in the render path of a form,
 * and the loader would stop being the one place that decides what the form may offer.
 * Making `vendors` required is what keeps a future route from shipping a picker with a
 * silently empty option list.
 *
 * ✅ **`status` is a `<Select>`: the column is `StockStatus?`, so the database enforces
 * the value set the form offers** — the form cannot offer a value the database would
 * refuse, and no second copy of the value set can drift from it. `category` stays a
 * free-text input: its column is still `String?` with no database-enforced value set, and
 * a `<Select>` over a set the database does not enforce would make this form refuse values
 * `inventory.stock.import.server.ts` can write. ⚠️ **The supplier picker is the
 * counter-example that makes the rule legible:** it IS a `<Select>`, because a `vendorId`
 * is a foreign key whose set the database enforces through the FK itself, and a free-text
 * box would accept a typo that the `SetNull` FK cannot catch.
 */

/**
 * 🔴 **How a blank tag box is handled: it DELETES that tag — explicitly, not inherited
 * from whatever the field happened to do.**
 *
 * `tags` is the **only** field in `inventory.stock.schema.ts` without the
 * `emptyToUndefined` every other optional field runs through (`:26-32` against `:116`), so
 * a rendered-but-blank box is rejected by `z.string().trim().min(1)` — as a `ValidationError`
 * on the **whole object**: three tags on screen, clear one box, and the other two are refused
 * along with it. The two options were *filter empties on submit* or *render per-tag errors*;
 * this is the first.
 *
 * 🔴 **A blank box arrives as `""` inside the array for 2+ inputs, and as a bare `string`
 * for the one input an untouched create form sends.** `formDataToObject` has collapsed
 * repeated keys by then, so a single box is not an array at all: that case fails as
 * `invalid_type` *"Expected array, received string"*, not as a length failure. Both routes
 * therefore normalise through the shared `tagsFromForm` (`app/lib/validation.server.ts`),
 * which handles the bare string and the array in one place.
 *
 * ⚠️ **The user-visible consequence is stated rather than left to be discovered:** clearing
 * a box is how you remove a tag. A tag you cannot remove is a tag you can only add. This is
 * the rule every other optional field on this form already follows — a blank means "not
 * stated" — so it is the consistent reading rather than a special case invented for this
 * field. The alternative (per-tag errors) would leave a blank box as an unresolvable dead
 * end, because there is no "add tag" button to send the user to instead.
 *
 * ⚠️ **Why at least one box is ALWAYS rendered, even for an item with no tags:** with zero
 * boxes the control is unreachable — an untagged item could then never *gain* a tag from
 * this form. The spare box submits `""`, the route filters it, and an untagged row's tag
 * list is unchanged.
 */
export interface StockDefaults {
  name?: string | null;
  sku?: string | null;
  serial?: string | null;
  quantity?: number;
  unit?: string | null;
  category?: string | null;
  status?: StockStatus | null;
  purchasedAt?: string | null; // yyyy-mm-dd
  purchasePrice?: string | null;
  warrantyExpiresAt?: string | null; // yyyy-mm-dd
  locationId?: string | null;
  /** The item's current supplier, for the picker's preselection. */
  vendorId?: string | null;
  /**
   * The item's current tags — one box per entry, plus always one spare.
   *
   * ⚠️ **`undefined` renders NO tags control at all**, which is a different statement from
   * `[]`: `undefined` means "this form does not own the field" and the route then carries
   * the row's value, while `[]` means "this form owns the field and it is currently empty".
   * Both states are real, and collapsing them is what would make a save from a form that
   * omits the control indistinguishable from a user who cleared every tag.
   *
   * 🔴 **Both routes must therefore pass an array — the create route as a literal `tags: []`.**
   * A create form that passed `undefined` would render no control and the create action has
   * no row to carry from, so "this form does not own the field" is not a state it can honour.
   */
  tags?: string[];
}

/** One row of the location picker: the tree flattened, with its real depth. */
export interface LocationOption {
  id: string;
  name: string;
  kind: string;
  depth: number;
}

export function StockFormFields({
  locations,
  vendors,
  defaults,
}: StockVendorSelectProps & {
  locations: LocationOption[];
  defaults?: StockDefaults;
}) {
  const locale = useLocale();
  const t = useT();
  /**
   * One box per tag, **plus one spare** — and `null` when the form does not own the field.
   *
   * ⚠️ The spare is what keeps the control reachable: with `length` boxes and no tags, the
   * control would render nothing and an untagged item could never *gain* one from this
   * form. The spare submits `""`, the route filters it, and nothing is written.
   *
   * ⚠️ It is computed here rather than inside the JSX so the type is narrowed ONCE: a
   * `defaults?.tags !== undefined` guard around the JSX does not narrow the property inside
   * a `map` callback, and `tsc` says so (`TS18048`).
   */
  const tagBoxes = defaults?.tags === undefined ? null : [...defaults.tags, ""];
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField name="name" label={t("inventory.stock.form.name")} className="sm:col-span-2">
          <Input
            name="name"
            required
            defaultValue={defaults?.name ?? ""}
            placeholder={t("inventory.stock.form.namePlaceholder")}
          />
        </FormField>
        <FormField
          name="quantity"
          label={t("inventory.stock.form.quantity")}
          hint={t("inventory.stock.form.quantityHint")}
        >
          <Input
            name="quantity"
            type="number"
            min={0}
            step={1}
            defaultValue={defaults?.quantity ?? 1}
            className="nums"
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField
          name="sku"
          label={t("inventory.stock.form.sku")}
          hint={t("inventory.stock.form.uniqueHint")}
        >
          <Input name="sku" defaultValue={defaults?.sku ?? ""} className="font-mono" />
        </FormField>
        <FormField
          name="serial"
          label={t("inventory.stock.form.serial")}
          hint={t("inventory.stock.form.uniqueHint")}
        >
          <Input name="serial" defaultValue={defaults?.serial ?? ""} className="font-mono" />
        </FormField>
        <FormField name="unit" label={t("inventory.stock.form.unit")}>
          <Input
            name="unit"
            defaultValue={defaults?.unit ?? ""}
            placeholder={t("inventory.stock.form.unitPlaceholder")}
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <StockVendorSelect vendors={vendors} defaultVendorId={defaults?.vendorId} />
        <FormField
          name="locationId"
          label={t("inventory.stock.form.location")}
          hint={t("inventory.stock.form.locationHint")}
        >
          <Select name="locationId" defaultValue={defaults?.locationId ?? ""}>
            <option value="">{t("inventory.stock.form.noLocation")}</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {/* The real depth, so the picker cannot present a ROOM as a peer of its
                    BUILDING — the same reason `m.locations` indents its rows. */}
                {`${"— ".repeat(loc.depth)}${loc.name} · ${kindLabel(locale, loc.kind)}`}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          name="category"
          label={t("inventory.stock.form.category")}
          hint={t("inventory.stock.form.categoryHint")}
        >
          <Input name="category" defaultValue={defaults?.category ?? ""} />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="status"
          label={t("inventory.stock.form.status")}
          hint={t("inventory.stock.form.statusHint")}
        >
          <Select name="status" defaultValue={defaults?.status ?? ""}>
            <option value="">—</option>
            {Object.values(StockStatus).map((value) => (
              <option key={value} value={value}>
                {stockStatusLabel(locale, value)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          name="warrantyExpiresAt"
          label={t("inventory.stock.form.warranty")}
          hint={t("inventory.stock.form.warrantyHint")}
        >
          <Input
            name="warrantyExpiresAt"
            type="date"
            defaultValue={defaults?.warrantyExpiresAt ?? ""}
            className="nums"
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="purchasedAt" label={t("inventory.stock.form.purchasedAt")}>
          <Input
            name="purchasedAt"
            type="date"
            defaultValue={defaults?.purchasedAt ?? ""}
            className="nums"
          />
        </FormField>
        <FormField
          name="purchasePrice"
          label={t("inventory.stock.form.price")}
          hint={t("inventory.stock.form.priceHint")}
        >
          <Input
            name="purchasePrice"
            inputMode="decimal"
            defaultValue={defaults?.purchasePrice ?? ""}
            placeholder="0.00"
            className="nums"
          />
        </FormField>
      </div>

      {/* 🔴 The tags control. `tagBoxes === null` renders NOTHING — the form does not
          own the field, and the route carries the row's value (see the header). An array
          (empty or not) renders one box per entry plus one spare. */}
      {tagBoxes ? (
        <FormField
          name="tags"
          label={t("inventory.stock.form.tags")}
          hint={t("inventory.stock.form.tagsHint")}
        >
          <div className="flex flex-col gap-2">
            {tagBoxes.map((tag, i) => (
              <Input
                key={i}
                name="tags"
                defaultValue={tag}
                placeholder={
                  i === tagBoxes.length - 1 ? t("inventory.stock.form.tagPlaceholder") : undefined
                }
                aria-label={
                  i === tagBoxes.length - 1
                    ? t("inventory.stock.form.newTag")
                    : t("inventory.stock.form.tagN", { n: i + 1 })
                }
              />
            ))}
          </div>
        </FormField>
      ) : null}
    </>
  );
}
