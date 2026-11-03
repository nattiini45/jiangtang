import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { RoomStatus } from "~/generated/prisma/enums";
import { statusToken } from "~/lib/status";
import type { CampusWithBuildings } from "~/domains/rooms/rooms.queries.server";
import { CampusBuildingPicker } from "./campus-building-picker";
import { CapabilityListInput } from "./capability-list-input";
import { RoomFeatureToggles, type RoomFlags } from "./room-feature-toggles";
import { useLocale, useT } from "~/i18n/use-t";

export interface RoomDefaults extends RoomFlags {
  name?: string;
  roomNumber?: string | null;
  campusId?: string | null;
  buildingId?: string | null;
  capacity?: number | null;
  owner?: string | null;
  status?: string;
  videoInputs?: string[];
  audioOutputs?: string[];
  bookingUrl?: string | null;
  manualUrl?: string | null;
  virtualTourUrl?: string | null;
  tipsNotes?: string | null;
  renewalStatus?: string | null;
  renewalFrom?: string | null; // yyyy-mm-dd for the date input
  renewalTo?: string | null;
}

export function RoomFormFields({
  campuses,
  defaults,
}: {
  campuses: CampusWithBuildings[];
  defaults?: RoomDefaults;
}) {
  const locale = useLocale();
  const t = useT();
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField name="name" label={t("rooms.form.name")}>
          <Input
            name="name"
            defaultValue={defaults?.name ?? ""}
            required
            placeholder={t("rooms.form.namePlaceholder")}
          />
        </FormField>
        <FormField name="roomNumber" label={t("rooms.form.roomNumber")}>
          <Input
            name="roomNumber"
            defaultValue={defaults?.roomNumber ?? ""}
            placeholder={t("rooms.form.roomNumberPlaceholder")}
          />
        </FormField>
      </div>

      <CampusBuildingPicker
        campuses={campuses}
        defaults={{ campusId: defaults?.campusId, buildingId: defaults?.buildingId }}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField name="capacity" label={t("rooms.form.capacity")}>
          <Input name="capacity" type="number" min="1" defaultValue={defaults?.capacity ?? ""} />
        </FormField>
        <FormField name="owner" label={t("rooms.form.owner")}>
          <Input name="owner" defaultValue={defaults?.owner ?? ""} />
        </FormField>
        <FormField name="status" label={t("rooms.form.status")}>
          <Select name="status" defaultValue={defaults?.status ?? RoomStatus.ALL_GOOD}>
            {Object.values(RoomStatus).map((s) => (
              <option key={s} value={s}>
                {statusToken(locale, "room", s).label}
              </option>
            ))}
          </Select>
        </FormField>
      </div>

      <RoomFeatureToggles defaults={defaults} />

      <div className="grid gap-4 sm:grid-cols-2">
        <CapabilityListInput
          name="videoInputs"
          label={t("rooms.form.videoInputs")}
          defaults={defaults?.videoInputs}
          placeholder={t("rooms.form.videoInputsPlaceholder")}
        />
        <CapabilityListInput
          name="audioOutputs"
          label={t("rooms.form.audioOutputs")}
          defaults={defaults?.audioOutputs}
          placeholder={t("rooms.form.audioOutputsPlaceholder")}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <FormField name="bookingUrl" label={t("rooms.form.bookingUrl")}>
          <Input
            name="bookingUrl"
            type="url"
            defaultValue={defaults?.bookingUrl ?? ""}
            placeholder="https://…"
          />
        </FormField>
        <FormField name="manualUrl" label={t("rooms.form.manualUrl")}>
          <Input
            name="manualUrl"
            type="url"
            defaultValue={defaults?.manualUrl ?? ""}
            placeholder="https://…"
          />
        </FormField>
        <FormField name="virtualTourUrl" label={t("rooms.form.tourUrl")}>
          <Input
            name="virtualTourUrl"
            type="url"
            defaultValue={defaults?.virtualTourUrl ?? ""}
            placeholder="https://…"
          />
        </FormField>
      </div>

      <FormField name="tipsNotes" label={t("rooms.form.tips")}>
        <Textarea name="tipsNotes" defaultValue={defaults?.tipsNotes ?? ""} />
      </FormField>

      <fieldset className="bg-card shadow-surface-2 grid gap-4 rounded-lg p-4 sm:grid-cols-3">
        <legend className="text-muted-foreground px-1 text-xs">{t("rooms.form.renewal")}</legend>
        <FormField name="renewalStatus" label={t("rooms.form.renewalStatus")}>
          <Input
            name="renewalStatus"
            defaultValue={defaults?.renewalStatus ?? ""}
            placeholder={t("rooms.form.renewalStatusPlaceholder")}
          />
        </FormField>
        <FormField name="renewalFrom" label={t("rooms.form.renewalFrom")}>
          <Input name="renewalFrom" type="date" defaultValue={defaults?.renewalFrom ?? ""} />
        </FormField>
        <FormField name="renewalTo" label={t("rooms.form.renewalTo")}>
          <Input name="renewalTo" type="date" defaultValue={defaults?.renewalTo ?? ""} />
        </FormField>
      </fieldset>
    </>
  );
}
