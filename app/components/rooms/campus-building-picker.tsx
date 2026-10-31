import * as React from "react";
import { FormField } from "~/components/forms";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import type { CampusWithBuildings } from "~/domains/rooms/rooms.queries.server";
import { useT } from "~/i18n/use-t";

const NEW = "__new__";

/**
 * Cascading campus → building picker with inline "+ new" for each. The visible
 * selects drive local state; hidden campusId/buildingId inputs carry the real
 * value ("" when "+ new" is chosen, so the server reads newCampusName /
 * newBuildingName instead). Matches resolveLocation() in rooms.mutations.
 */
export function CampusBuildingPicker({
  campuses,
  defaults,
}: {
  campuses: CampusWithBuildings[];
  defaults?: { campusId?: string | null; buildingId?: string | null };
}) {
  const t = useT();
  const [campusChoice, setCampusChoice] = React.useState<string>(defaults?.campusId ?? "");
  const [buildingChoice, setBuildingChoice] = React.useState<string>(defaults?.buildingId ?? "");

  const selectedCampus = campuses.find((c) => c.id === campusChoice);
  const buildings = selectedCampus?.buildings ?? [];

  const campusIdValue = campusChoice === NEW ? "" : campusChoice;
  const buildingIdValue = buildingChoice === NEW ? "" : buildingChoice;

  function onCampusChange(value: string) {
    setCampusChoice(value);
    // A building can't outlive its campus selection.
    setBuildingChoice("");
  }

  const newCampus = campusChoice === NEW;
  const hasCampus = campusChoice !== "";

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="campusId" value={campusIdValue} />
      <input type="hidden" name="buildingId" value={buildingIdValue} />

      <FormField name="campusId" label={t("rooms.picker.campus")}>
        <Select value={campusChoice} onChange={(e) => onCampusChange(e.currentTarget.value)}>
          <option value="">{t("rooms.picker.noCampus")}</option>
          {campuses.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value={NEW}>{t("rooms.picker.newCampusOption")}</option>
        </Select>
      </FormField>

      {newCampus ? (
        <FormField name="newCampusName" label={t("rooms.picker.newCampus")}>
          <Input
            name="newCampusName"
            placeholder={t("rooms.picker.newCampusPlaceholder")}
            autoFocus
          />
        </FormField>
      ) : null}

      {hasCampus && !newCampus ? (
        <FormField name="buildingId" label={t("rooms.picker.building")}>
          <Select value={buildingChoice} onChange={(e) => setBuildingChoice(e.currentTarget.value)}>
            <option value="">{t("rooms.picker.noBuilding")}</option>
            {buildings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
            <option value={NEW}>{t("rooms.picker.newBuildingOption")}</option>
          </Select>
        </FormField>
      ) : null}

      {buildingChoice === NEW || newCampus ? (
        <FormField name="newBuildingName" label={t("rooms.picker.newBuilding")}>
          <Input name="newBuildingName" placeholder={t("rooms.picker.newBuildingPlaceholder")} />
        </FormField>
      ) : null}
    </div>
  );
}
