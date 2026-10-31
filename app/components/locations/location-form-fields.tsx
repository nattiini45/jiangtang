import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import type { LocationTreeNode } from "~/domains/locations/locations.tree.server";
import { LOCATION_KINDS, kindLabel } from "./labels";
import { useLocale, useT } from "~/i18n/use-t";

/**
 * Shared field block for the create + edit location forms, bound to
 * `locationCreateSchema` / `locationEditSchema` (`app/domains/locations/`).
 *
 * **`parentId` is deliberately a create-time field only.** `locationEditSchema`
 * omits it: reparenting goes through `moveLocation`, so the cycle refusal is
 * the only way the edge can ever change (see the domain's own header). A form
 * that posted a `parentId` on edit would be silently ignored by the schema —
 * the worst outcome, because the UI would claim a move that never happened.
 */
export interface LocationFormDefaults {
  name?: string | null;
  kind?: string | null;
  code?: string | null;
  address?: string | null;
  description?: string | null;
}

export function LocationFormFields({
  defaults,
  parents,
  defaultParentId,
}: {
  defaults?: LocationFormDefaults;
  /** Every location, flattened from the tree walk. Create-only. */
  parents?: LocationTreeNode[];
  defaultParentId?: string | null;
}) {
  const locale = useLocale();
  const t = useT();
  return (
    <>
      <FormField name="name" label={t("locations.form.name")}>
        <Input
          name="name"
          defaultValue={defaults?.name ?? ""}
          required
          placeholder={t("locations.form.namePlaceholder")}
        />
      </FormField>

      <FormField name="kind" label={t("locations.form.kind")} hint={t("locations.form.kindHint")}>
        <Select name="kind" defaultValue={defaults?.kind ?? "ROOM"} required>
          {LOCATION_KINDS.map((k) => (
            <option key={k} value={k}>
              {kindLabel(locale, k)}
            </option>
          ))}
        </Select>
      </FormField>

      <FormField name="code" label={t("locations.form.code")} hint={t("locations.form.codeHint")}>
        <Input
          name="code"
          defaultValue={defaults?.code ?? ""}
          placeholder={t("locations.form.codePlaceholder")}
        />
      </FormField>

      <FormField name="address" label={t("locations.form.address")} hint={t("common.optional")}>
        <Input
          name="address"
          defaultValue={defaults?.address ?? ""}
          placeholder={t("locations.form.addressPlaceholder")}
        />
      </FormField>

      <FormField
        name="description"
        label={t("locations.form.description")}
        hint={t("common.optional")}
      >
        <Textarea
          name="description"
          defaultValue={defaults?.description ?? ""}
          placeholder={t("locations.form.descriptionPlaceholder")}
        />
      </FormField>

      {parents ? (
        <FormField
          name="parentId"
          label={t("locations.form.parent")}
          hint={t("locations.form.parentHint")}
        >
          <Select name="parentId" defaultValue={defaultParentId ?? ""}>
            <option value="">{t("locations.form.topLevel")}</option>
            {parents.map((p) => (
              // Indent the option labels by the same depth the tree draws, so a
              // long list reads as a hierarchy rather than a flat alphabet.
              <option key={p.id} value={p.id}>
                {`${"— ".repeat(p.depth)}${p.name}`}
              </option>
            ))}
          </Select>
        </FormField>
      ) : null}
    </>
  );
}
