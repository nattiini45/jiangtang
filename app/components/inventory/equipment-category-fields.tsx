import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { MicKind } from "~/generated/prisma/enums";
import { useLocale, useT } from "~/i18n/use-t";
import { micKindLabel } from "./labels";
import type { EquipmentDefaults } from "./equipment-form-fields";

const legend = "text-muted-foreground px-1 text-xs uppercase tracking-wide";

/** Per-category attribute groups. The selected category decides which group shows. */
export function EquipmentCategoryFields({
  category,
  defaults,
}: {
  category: string;
  defaults?: EquipmentDefaults;
}) {
  const t = useT();
  const locale = useLocale();
  if (category === "PC") {
    return (
      <fieldset className="border-border grid gap-4 border p-3 sm:grid-cols-2">
        <legend className={legend}>{t("inventory.catFields.pc")}</legend>
        <FormField name="hostname" label={t("inventory.catFields.hostname")}>
          <Input name="hostname" defaultValue={defaults?.hostname ?? ""} />
        </FormField>
        <FormField name="ipAddress" label={t("inventory.catFields.ip")}>
          <Input
            name="ipAddress"
            defaultValue={defaults?.ipAddress ?? ""}
            placeholder="192.0.2.1"
          />
        </FormField>
        <FormField name="macAddress" label={t("inventory.catFields.mac")}>
          <Input
            name="macAddress"
            defaultValue={defaults?.macAddress ?? ""}
            placeholder="02:00:00:3C:4D:5E"
          />
        </FormField>
        <FormField name="dellServiceTag" label={t("inventory.catFields.dellService")}>
          <Input name="dellServiceTag" defaultValue={defaults?.dellServiceTag ?? ""} />
        </FormField>
        <FormField name="dellExpressTag" label={t("inventory.catFields.dellExpress")}>
          <Input name="dellExpressTag" defaultValue={defaults?.dellExpressTag ?? ""} />
        </FormField>
      </fieldset>
    );
  }
  if (category === "MICROPHONE") {
    return (
      <fieldset className="border-border grid gap-4 border p-3 sm:grid-cols-2">
        <legend className={legend}>{t("inventory.catFields.microphone")}</legend>
        <FormField name="micKind" label={t("inventory.catFields.micKind")}>
          <Select name="micKind" defaultValue={defaults?.micKind ?? ""}>
            <option value="">{t("inventory.catFields.noMicKind")}</option>
            {Object.values(MicKind).map((k) => (
              <option key={k} value={k}>
                {micKindLabel(locale, k)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField name="frequencyMhz" label={t("inventory.catFields.frequency")}>
          <Input
            name="frequencyMhz"
            type="number"
            step="0.001"
            defaultValue={defaults?.frequencyMhz ?? ""}
          />
        </FormField>
        <FormField name="band" label={t("inventory.catFields.band")}>
          <Input
            name="band"
            defaultValue={defaults?.band ?? ""}
            placeholder={t("inventory.catFields.bandPlaceholder")}
          />
        </FormField>
        <FormField name="channelLabel" label={t("inventory.catFields.channel")}>
          <Input
            name="channelLabel"
            defaultValue={defaults?.channelLabel ?? ""}
            placeholder={t("inventory.catFields.channelPlaceholder")}
          />
        </FormField>
      </fieldset>
    );
  }
  if (category === "PROJECTOR") {
    return (
      <fieldset className="border-border grid gap-4 border p-3 sm:grid-cols-2">
        <legend className={legend}>{t("inventory.catFields.projector")}</legend>
        <FormField name="lampType" label={t("inventory.catFields.lampType")}>
          <Input name="lampType" defaultValue={defaults?.lampType ?? ""} />
        </FormField>
        <FormField name="lastLampChangeAt" label={t("inventory.catFields.lastLampChange")}>
          <Input
            name="lastLampChangeAt"
            type="date"
            defaultValue={defaults?.lastLampChangeAt ?? ""}
          />
        </FormField>
      </fieldset>
    );
  }
  if (category === "REMOTE" || category === "MEDIA_CONTROL") {
    return (
      <fieldset className="border-border grid gap-4 border p-3 sm:grid-cols-2">
        <legend className={legend}>{t("inventory.catFields.control")}</legend>
        <FormField name="color" label={t("inventory.catFields.color")}>
          <Input name="color" defaultValue={defaults?.color ?? ""} />
        </FormField>
      </fieldset>
    );
  }
  return null;
}
