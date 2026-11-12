import * as React from "react";
import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { EquipmentMobility, EquipmentStatus } from "~/generated/prisma/enums";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";
import { KindOptions, type KindGroups } from "./kind-options";
import { statusToken } from "~/lib/status";
import { mobilityLabel } from "./labels";
import { EquipmentCategoryFields } from "./equipment-category-fields";
import { useLocale, useT } from "~/i18n/use-t";
import { FieldInputs } from "~/components/fields/field-inputs";
import type { Field } from "~/lib/custom-fields/fields";

export interface EquipmentDefaults {
  category?: string;
  kindId?: string;
  modelId?: string | null;
  roomId?: string | null;
  mobility?: string;
  status?: string;
  name?: string | null;
  assetTag?: string | null;
  serial?: string | null;
  hostname?: string | null;
  ipAddress?: string | null;
  macAddress?: string | null;
  dellServiceTag?: string | null;
  dellExpressTag?: string | null;
  micKind?: string | null;
  frequencyMhz?: string | null;
  band?: string | null;
  channelLabel?: string | null;
  lampType?: string | null;
  lastLampChangeAt?: string | null; // yyyy-mm-dd
  color?: string | null;
  attributes?: string | null;
}

export function EquipmentFormFields({
  models,
  rooms,
  kinds,
  defaults,
  fields = [],
  stored,
}: {
  models: { id: string; name: string; manufacturer: string | null; customValues?: unknown }[];
  rooms: { id: string; name: string }[];
  kinds: KindGroups;
  defaults?: EquipmentDefaults;
  fields?: Field[];
  stored?: unknown;
}) {
  const locale = useLocale();
  const t = useT();
  const [modelId, setModelId] = React.useState(defaults?.modelId ?? "");
  const options = kinds.flatMap((group) => group.kinds);
  const [kindId, setKindId] = React.useState(
    defaults?.kindId ??
      options.find((kind) => kind.systemKey === "projector")?.id ??
      options[0]?.id ??
      "",
  );
  const key = options.find((kind) => kind.id === kindId)?.systemKey;
  const category =
    Object.entries(DEFAULT_EQUIPMENT_KINDS).find(([, value]) => value.key === key)?.[0] ?? "OTHER";
  const [mobility, setMobility] = React.useState<string>(defaults?.mobility ?? "FIXED");
  const pooled = mobility === "POOLED";

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="kindId" label={t("inventory.kind")}>
          <Select
            name="kindId"
            value={kindId}
            required
            onChange={(e) => setKindId(e.currentTarget.value)}
          >
            <KindOptions groups={kinds} />
          </Select>
        </FormField>
        <FormField name="mobility" label={t("inventory.form.mobility")}>
          <Select
            name="mobility"
            value={mobility}
            onChange={(e) => setMobility(e.currentTarget.value)}
          >
            {Object.values(EquipmentMobility).map((m) => (
              <option key={m} value={m}>
                {mobilityLabel(locale, m)}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          name="roomId"
          label={t("inventory.form.room")}
          hint={pooled ? t("inventory.form.roomHintPooled") : t("inventory.form.roomHintFixed")}
        >
          <Select name="roomId" defaultValue={defaults?.roomId ?? ""} disabled={pooled}>
            <option value="">{t("inventory.form.noRoom")}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField name="modelId" label={t("inventory.form.model")}>
          <Select
            name="modelId"
            value={modelId}
            onChange={(event) => setModelId(event.currentTarget.value)}
          >
            <option value="">{t("inventory.form.noModel")}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.manufacturer ? `${m.manufacturer} ` : ""}
                {m.name}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField name="name" label={t("inventory.form.name")}>
          <Input
            name="name"
            defaultValue={defaults?.name ?? ""}
            placeholder={t("inventory.form.namePlaceholder")}
          />
        </FormField>
        <FormField name="assetTag" label={t("inventory.form.assetTag")}>
          <Input name="assetTag" defaultValue={defaults?.assetTag ?? ""} className="font-mono" />
        </FormField>
        <FormField name="serial" label={t("inventory.form.serial")}>
          <Input name="serial" defaultValue={defaults?.serial ?? ""} className="font-mono" />
        </FormField>
      </div>

      <FormField name="status" label={t("inventory.form.status")} className="max-w-xs">
        <Select name="status" defaultValue={defaults?.status ?? EquipmentStatus.OPERATIONAL}>
          {Object.values(EquipmentStatus).map((s) => (
            <option key={s} value={s}>
              {statusToken(locale, "equipment", s).label}
            </option>
          ))}
        </Select>
      </FormField>

      <EquipmentCategoryFields category={category} defaults={defaults} />

      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 text-base font-semibold">{t("ports.network")}</legend>
        <FormField name="hostname" label={t("inventory.catFields.hostname")}>
          <Input name="hostname" defaultValue={defaults?.hostname ?? ""} />
        </FormField>
        <FormField name="ipAddress" label={t("inventory.catFields.ip")}>
          <Input
            name="ipAddress"
            defaultValue={defaults?.ipAddress ?? ""}
            placeholder="192.0.2.1"
            className="font-mono"
          />
        </FormField>
        <FormField name="macAddress" label={t("inventory.catFields.mac")}>
          <Input
            name="macAddress"
            defaultValue={defaults?.macAddress ?? ""}
            placeholder="02:00:00:3C:4D:5E"
            className="font-mono"
          />
        </FormField>
      </fieldset>

      <details className="bg-card shadow-surface-2 rounded-lg p-4">
        <summary className="cursor-pointer text-base font-semibold">
          {t("inventory.form.attributes")}
        </summary>
        <div className="mt-3">
          <Textarea
            name="attributes"
            defaultValue={defaults?.attributes ?? ""}
            placeholder='{"key":"value"}'
          />
        </div>
      </details>
      <FieldInputs
        fields={fields}
        stored={stored}
        kindId={kindId}
        modelId={modelId}
        modelValues={models.find((model) => model.id === modelId)?.customValues}
      />
    </>
  );
}
