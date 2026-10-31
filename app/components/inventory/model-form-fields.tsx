import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { EquipmentCategory } from "~/generated/prisma/enums";
import { useLocale, useT } from "~/i18n/use-t";
import { categoryLabel } from "./labels";

export interface ModelDefaults {
  manufacturer?: string | null;
  name?: string;
  category?: string;
  specNotes?: string | null;
  manualUrl?: string | null;
}

/** Shared field block for the create + edit model forms (bound to ZodForm). */
export function ModelFormFields({ defaults }: { defaults?: ModelDefaults }) {
  const t = useT();
  const locale = useLocale();
  return (
    <>
      <FormField
        name="manufacturer"
        label={t("inventory.models.manufacturer")}
        hint={t("inventory.models.manufacturerHint")}
      >
        <Input
          name="manufacturer"
          defaultValue={defaults?.manufacturer ?? ""}
          placeholder={t("inventory.models.manufacturer")}
        />
      </FormField>
      <FormField name="name" label={t("inventory.models.name")}>
        <Input
          name="name"
          defaultValue={defaults?.name ?? ""}
          required
          placeholder={t("inventory.models.namePlaceholder")}
        />
      </FormField>
      <FormField name="category" label={t("inventory.models.category")}>
        <Select name="category" defaultValue={defaults?.category ?? "PROJECTOR"}>
          {Object.values(EquipmentCategory).map((c) => (
            <option key={c} value={c}>
              {categoryLabel(locale, c)}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField name="specNotes" label={t("inventory.models.specNotes")}>
        <Textarea
          name="specNotes"
          defaultValue={defaults?.specNotes ?? ""}
          placeholder={t("inventory.models.specPlaceholder")}
        />
      </FormField>
      <FormField name="manualUrl" label={t("inventory.models.manualUrl")}>
        <Input
          name="manualUrl"
          type="url"
          defaultValue={defaults?.manualUrl ?? ""}
          placeholder="https://…"
        />
      </FormField>
    </>
  );
}
