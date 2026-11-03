import { Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { safeParseForm } from "~/lib/validation.server";
import { tr } from "~/i18n/request-locale.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { getRoomBySlug, listCampuses } from "~/domains/rooms/rooms.queries.server";
import { roomCloneSchema } from "~/domains/rooms/rooms.schema";
import { cloneRoom } from "~/domains/rooms/rooms.mutations.server";
import { FormField, ZodForm } from "~/components/forms";
import { CampusBuildingPicker } from "~/components/rooms/campus-building-picker";
import { Input } from "~/components/ui/input";
import { Checkbox } from "~/components/ui/checkbox";
import { Button } from "~/components/ui/button";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

const COPY_OPTIONS = [
  { name: "copyFeatures", labelKey: "rooms.clone.copyFeatures" },
  { name: "copyCapabilities", labelKey: "rooms.clone.copyCapabilities" },
  { name: "copyEquipment", labelKey: "rooms.clone.copyEquipment" },
  { name: "copyTips", labelKey: "rooms.clone.copyTips" },
] as const;

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "rooms.meta.clone", {
        name: data?.source.name ?? t(locale, "rooms.meta.fallbackName"),
      }),
    },
  ];
}

export async function loader({ params }: Route.LoaderArgs) {
  const [source, campuses] = await Promise.all([getRoomBySlug(params.slug), listCampuses()]);
  if (!source) throw toErrorResponse(new NotFoundError(tr("err.room.notFound")));
  return { source, campuses };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const result = await safeParseForm(request, roomCloneSchema);
  if (!result.success) return { fieldErrors: result.fieldErrors };
  try {
    const room = await cloneRoom(actor, params.slug, result.data);
    await emitChange({ entityType: "room", id: room.id, op: "created" });
    return redirect(`/rooms/${room.slug}`);
  } catch (e) {
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors };
    throw toErrorResponse(e);
  }
}

export default function CloneRoom({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const { source, campuses } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">{t("rooms.clone.title", { name: source.name })}</h1>
        <Link
          to={`/rooms/${source.slug}`}
          className="text-muted-foreground text-sm hover:underline"
        >
          {t("rooms.clone.back")}
        </Link>
      </div>
      <p className="text-muted-foreground mt-1 text-sm">{t("rooms.clone.description")}</p>

      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField name="name" label={t("rooms.clone.newName")}>
            <Input
              name="name"
              required
              defaultValue={t("rooms.clone.defaultName", { name: source.name })}
            />
          </FormField>
          <FormField name="roomNumber" label={t("rooms.clone.roomNumber")}>
            <Input name="roomNumber" />
          </FormField>
        </div>

        <CampusBuildingPicker
          campuses={campuses}
          defaults={{ campusId: source.campusId, buildingId: source.buildingId }}
        />

        <fieldset className="bg-card shadow-surface-2 grid gap-2 rounded-lg p-4 sm:grid-cols-2">
          <legend className="text-muted-foreground px-1 text-xs">{t("rooms.clone.copy")}</legend>
          {COPY_OPTIONS.map((c) => (
            <label key={c.name} className="flex items-center gap-2 text-sm">
              <Checkbox name={c.name} defaultChecked />
              {t(c.labelKey)}
            </label>
          ))}
        </fieldset>

        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("rooms.clone.busy") : t("rooms.clone.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to={`/rooms/${source.slug}`}>{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
