import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { useT } from "~/i18n/use-t";
import { KindOptions, type KindGroups } from "./kind-options";

export interface ModelDefaults {
  manufacturer?: string | null;
  name?: string;
  category?: string;
  kindId?: string;
  specNotes?: string | null;
  manualUrl?: string | null;
}

/** Shared field block for the create + edit model forms (bound to ZodForm). */
export function ModelFormFields({
  defaults,
  kinds,
}: {
  defaults?: ModelDefaults;
  kinds: KindGroups;
}) {
  const t = useT();
  const options = kinds.flatMap((group) => group.kinds);
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
      <FormField name="kindId" label={t("inventory.kind")}>
        <Select
          name="kindId"
          required
          defaultValue={
            defaults?.kindId ??
            options.find((kind) => kind.systemKey === "projector")?.id ??
            options[0]?.id
          }
        >
          <KindOptions groups={kinds} />
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
