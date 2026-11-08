import { useNavigation } from "react-router";
import type { FieldErrors } from "~/lib/validation.server";
import type { CampusWithBuildings } from "~/domains/rooms/rooms.queries.server";
import { ZodForm, FormField } from "~/components/forms";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useT } from "~/i18n/use-t";

/**
 * Campus/building CRUD, rendered inside `/rooms?manage=campuses` — the nav has
 * no separate Campuses entry anymore, so this manager is the only home of the
 * CRUD. Its forms post to the current route (`/rooms`), whose action dispatches
 * the campus intents.
 */
export interface CampusActionData {
  intent: string;
  id?: string;
  campusId?: string;
  fieldErrors?: FieldErrors;
}

export function CampusesManager({
  campuses,
  actionData,
}: {
  campuses: CampusWithBuildings[];
  actionData?: CampusActionData | null;
}) {
  const t = useT();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  function fe(intent: string, match?: { id?: string; campusId?: string }): FieldErrors | undefined {
    if (!actionData || actionData.intent !== intent) return undefined;
    if (match?.id !== undefined && actionData.id !== match.id) return undefined;
    if (match?.campusId !== undefined && actionData.campusId !== match.campusId) return undefined;
    return actionData.fieldErrors;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* New campus */}
      <ZodForm
        method="post"
        fieldErrors={fe("createCampus")}
        className="bg-card shadow-surface-2 flex-row items-end gap-2 rounded-lg p-4"
      >
        <input type="hidden" name="_action" value="createCampus" />
        <FormField name="name" label={t("campuses.new.label")} className="flex-1">
          <Input name="name" placeholder={t("campuses.new.placeholder")} />
        </FormField>
        <Button type="submit" disabled={busy}>
          {t("campuses.add")}
        </Button>
      </ZodForm>

      {campuses.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("campuses.empty")}</p>
      ) : null}

      {campuses.map((campus) => (
        <div
          key={campus.id}
          className="bg-card shadow-surface-2 flex flex-col gap-3 rounded-lg p-4"
        >
          <ZodForm
            method="post"
            fieldErrors={fe("updateCampus", { id: campus.id })}
            className="flex-row items-center gap-2"
          >
            <input type="hidden" name="_action" value="updateCampus" />
            <input type="hidden" name="id" value={campus.id} />
            <Input
              name="name"
              aria-label={t("campuses.rename.aria", { name: campus.name })}
              defaultValue={campus.name}
              className="max-w-xs"
            />
            <Button type="submit" variant="tertiary" size="compact" disabled={busy}>
              {t("campuses.rename")}
            </Button>
            <span className="text-muted-foreground ml-auto text-xs">
              <span className="nums">{campus.roomCount}</span> {t("campuses.roomsCount")}
            </span>
          </ZodForm>

          <div className="border-border flex flex-col divide-y border-t pt-1">
            {campus.buildings.map((b) => (
              <ZodForm
                key={b.id}
                method="post"
                fieldErrors={fe("updateBuilding", { id: b.id })}
                className="flex-row items-center gap-2 py-2"
              >
                <input type="hidden" name="_action" value="updateBuilding" />
                <input type="hidden" name="id" value={b.id} />
                <input type="hidden" name="campusId" value={campus.id} />
                <Input
                  name="name"
                  aria-label={t("campuses.building.nameAria", { name: b.name })}
                  defaultValue={b.name}
                  className="max-w-[16rem]"
                />
                <Input
                  name="code"
                  aria-label={t("campuses.building.codeAria", { name: b.name })}
                  defaultValue={b.code ?? ""}
                  placeholder={t("campuses.building.codePlaceholder")}
                  className="max-w-[8rem]"
                />
                <Button type="submit" variant="ghost" size="compact" disabled={busy}>
                  {t("campuses.building.save")}
                </Button>
                <span className="text-muted-foreground ml-auto text-xs">
                  <span className="nums">{b.roomCount}</span> {t("campuses.roomsCount")}
                </span>
              </ZodForm>
            ))}
          </div>

          {/* Add building */}
          <ZodForm
            method="post"
            fieldErrors={fe("createBuilding", { campusId: campus.id })}
            className="border-border flex-row items-end gap-2 border-t pt-3"
          >
            <input type="hidden" name="_action" value="createBuilding" />
            <input type="hidden" name="campusId" value={campus.id} />
            <FormField name="name" label={t("campuses.building.new.label")} className="flex-1">
              <Input name="name" placeholder={t("campuses.building.new.placeholder")} />
            </FormField>
            <FormField name="code" label={t("campuses.building.code.label")} className="w-28">
              <Input name="code" placeholder={t("campuses.building.code.placeholder")} />
            </FormField>
            <Button type="submit" variant="tertiary" disabled={busy}>
              {t("campuses.add")}
            </Button>
          </ZodForm>
        </div>
      ))}
    </div>
  );
}
