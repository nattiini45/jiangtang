import { FormField } from "~/components/forms";
import { Select } from "~/components/ui/select";
import type { VendorOption } from "~/domains/vendors/vendors.queries.server";
import { useT } from "~/i18n/use-t";

/**
 * The **supplier picker** for a stock item — the control whose absence
 * `stock-form-fields.tsx` names in its own comment, and the one place a `vendorId` can
 * be chosen rather than typed.
 *
 * ⚠️ **This component renders options and nothing else. It cannot invent one.**
 * The options must come from the vendor query: a test removes one vendor from the query
 * result and checks that the option set changes, so a hand-written option list cannot pass.
 * That holds only because there is no fallback here: no hard-coded supplier, no "unknown
 * vendor" pseudo-option, and no free-text escape hatch. A bad supplier id must be impossible
 * rather than merely unlikely, and a picker that offered a typed id alongside its options
 * would make it possible, because the escape hatch is the bad id.
 *
 * **An empty string means "no supplier", and it is a real state rather than a missing
 * one.** `InventoryItem.vendorId` is `String?` with `onDelete: SetNull`, so an
 * item whose supplier is retired keeps the row and loses the link. The form's
 * `optionalId` turns a blank into `undefined`, and `stockData()` writes the `null`.
 */

export interface StockVendorSelectProps {
  /** Exactly `listVendors()`'s output — see the file header for why nothing else is accepted. */
  vendors: VendorOption[];
  /** The item's current supplier, if any. */
  defaultVendorId?: string | null;
  className?: string;
}

export function StockVendorSelect({ vendors, defaultVendorId, className }: StockVendorSelectProps) {
  const t = useT();
  return (
    <FormField
      name="vendorId"
      label={t("inventory.stock.form.vendor")}
      hint={t("inventory.stock.form.vendorHint")}
      className={className}
    >
      <Select name="vendorId" defaultValue={defaultVendorId ?? ""}>
        <option value="">{t("inventory.stock.form.noVendor")}</option>
        {vendors.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </Select>
    </FormField>
  );
}
