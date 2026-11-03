import { redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse, type FieldErrors } from "~/lib/validation.server";
import { resolveLocale } from "~/i18n/locale.server";
import { toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { listCampuses } from "~/domains/rooms/rooms.queries.server";
import {
  buildingCreateSchema,
  buildingEditSchema,
  campusCreateSchema,
  campusEditSchema,
} from "~/domains/rooms/rooms.schema";
import {
  createBuilding,
  createCampus,
  updateBuilding,
  updateCampus,
} from "~/domains/rooms/rooms.mutations.server";
import { ZodForm, FormField } from "~/components/forms";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "campuses.meta.title") }];
}

export async function loader(_: Route.LoaderArgs) {
  return { campuses: await listCampuses() };
}

type CampusActionData = {
  intent: string;
  id?: string;
  campusId?: string;
  fieldErrors?: FieldErrors;
};

export async function action({ request }: Route.ActionArgs): Promise<CampusActionData | Response> {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const obj = formDataToObject(await request.formData());
  const intent = String(obj._action ?? "");
  try {
    switch (intent) {
      case "createCampus": {
        const r = safeParse(campusCreateSchema, obj, locale);
        if (!r.success) return { intent, fieldErrors: r.fieldErrors };
        const c = await createCampus(actor, r.data);
        await emitChange({ entityType: "campus", id: c.id, op: "created" });
        return redirect("/campuses");
      }
      case "updateCampus": {
        const r = safeParse(campusEditSchema, obj, locale);
        if (!r.success) return { intent, id: String(obj.id ?? ""), fieldErrors: r.fieldErrors };
        const c = await updateCampus(actor, r.data.id, r.data);
        await emitChange({ entityType: "campus", id: c.id, op: "updated" });
        return redirect("/campuses");
      }
      case "createBuilding": {
        const r = safeParse(buildingCreateSchema, obj, locale);
        if (!r.success)
          return { intent, campusId: String(obj.campusId ?? ""), fieldErrors: r.fieldErrors };
        const b = await createBuilding(actor, r.data);
        await emitChange({ entityType: "building", id: b.id, op: "created" });
        return redirect("/campuses");
      }
      case "updateBuilding": {
        const r = safeParse(buildingEditSchema, obj, locale);
        if (!r.success) return { intent, id: String(obj.id ?? ""), fieldErrors: r.fieldErrors };
        const b = await updateBuilding(actor, r.data.id, r.data);
        await emitChange({ entityType: "building", id: b.id, op: "updated" });
        return redirect("/campuses");
      }
      default:
        return { intent };
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      return {
        intent,
        id: String(obj.id ?? ""),
        campusId: String(obj.campusId ?? ""),
        fieldErrors: e.fieldErrors,
      };
    }
    throw toErrorResponse(e);
  }
}

export default function Campuses({ loaderData, actionData }: Route.ComponentProps) {
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
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">{t("campuses.title")}</h1>
        <p className="text-muted-foreground text-sm">{t("campuses.subtitle")}</p>
      </div>

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

      {loaderData.campuses.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("campuses.empty")}</p>
      ) : null}

      {loaderData.campuses.map((campus) => (
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

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
