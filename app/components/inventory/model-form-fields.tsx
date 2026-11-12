import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { useT } from "~/i18n/use-t";
import { KindOptions, type KindGroups } from "./kind-options";
import { useState } from "react";
import { FieldInputs } from "~/components/fields/field-inputs";
import type { Field } from "~/lib/custom-fields/fields";

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
  fields = [],
  stored,
}: {
  defaults?: ModelDefaults;
  kinds: KindGroups;
  fields?: Field[];
  stored?: unknown;
}) {
  const t = useT();
  const options = kinds.flatMap((group) => group.kinds);
  const [kindId, setKindId] = useState(
    defaults?.kindId ??
      options.find((kind) => kind.systemKey === "projector")?.id ??
      options[0]?.id,
  );
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
          value={kindId}
          onChange={(event) => setKindId(event.currentTarget.value)}
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
      {fields.some(
        (field) =>
          field.level === "MODEL" &&
          (!field.kinds.length || field.kinds.some((link) => link.kindId === kindId)),
      ) ? (
        <section className="flex min-w-0 flex-col gap-3">
          <h2 className="text-base font-semibold">{t("fields.model.sheet")}</h2>
          <FieldInputs
            fields={fields.filter((field) => field.level === "MODEL")}
            kindId={kindId}
            stored={stored}
          />
        </section>
      ) : null}
    </>
  );
}
