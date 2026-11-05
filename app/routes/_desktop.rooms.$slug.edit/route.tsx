import { Form, Link, redirect, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import { NotFoundError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { getRoomBySlug, listCampuses } from "~/domains/rooms/rooms.queries.server";
import { roomEditSchema } from "~/domains/rooms/rooms.schema";
import { retireRoom, updateRoom } from "~/domains/rooms/rooms.mutations.server";
import { ZodForm } from "~/components/forms";
import { RoomFormFields, type RoomDefaults } from "~/components/rooms/room-form-fields";
import { Button } from "~/components/ui/button";
import { berlinDateInput } from "~/lib/format-date";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "rooms.meta.edit", {
        name: data?.room.name ?? t(locale, "rooms.meta.fallbackName"),
      }),
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const locale = resolveLocale(request);
  const [room, campuses] = await Promise.all([getRoomBySlug(params.slug), listCampuses()]);
  if (!room) throw toErrorResponse(new NotFoundError(t(locale, "err.room.notFound")));
  return { room, campuses };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "update");

  const room = await getRoomBySlug(params.slug);
  if (!room) throw toErrorResponse(new NotFoundError(t(locale, "err.room.notFound")));

  try {
    if (intent === "retire") {
      await retireRoom(actor, room.id);
      await emitChange({ entityType: "room", id: room.id, op: "updated" });
      return redirect(`/rooms/${room.slug}`);
    }
    const result = safeParse(roomEditSchema, formDataToObject(form), locale);
    if (!result.success) return { fieldErrors: result.fieldErrors };
    const updated = await updateRoom(actor, room.id, result.data);
    await emitChange({ entityType: "room", id: updated.id, op: "updated" });
    return redirect(`/rooms/${updated.slug}`);
  } catch (e) {
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors };
    throw toErrorResponse(e);
  }
}

export default function EditRoom({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const { room, campuses } = loaderData;
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const defaults: RoomDefaults = {
    name: room.name,
    roomNumber: room.roomNumber,
    campusId: room.campusId,
    buildingId: room.buildingId,
    capacity: room.capacity,
    owner: room.owner,
    status: room.status,
    hasProjector: room.hasProjector,
    hasMicrophony: room.hasMicrophony,
    hasBlackboard: room.hasBlackboard,
    hasWebConference: room.hasWebConference,
    hasAutoRecording: room.hasAutoRecording,
    mediaKeyRequired: room.mediaKeyRequired,
    videoInputs: room.videoInputs,
    audioOutputs: room.audioOutputs,
    bookingUrl: room.bookingUrl,
    manualUrl: room.manualUrl,
    virtualTourUrl: room.virtualTourUrl,
    tipsNotes: room.tipsNotes,
    renewalStatus: room.renewalStatus,
    renewalFrom: berlinDateInput(room.renewalFrom),
    renewalTo: berlinDateInput(room.renewalTo),
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">{t("rooms.edit.title", { name: room.name })}</h1>
        <Link to={`/rooms/${room.slug}`} className="text-muted-foreground text-sm hover:underline">
          {t("rooms.edit.back")}
        </Link>
      </div>

      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="mt-4">
        <RoomFormFields campuses={campuses} defaults={defaults} />
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.saving") : t("rooms.edit.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to={`/rooms/${room.slug}`}>{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>

      <Form
        method="post"
        className="border-border mt-6 border-t pt-4"
        onSubmit={(e) => {
          if (!confirm(t("rooms.edit.confirmRetire", { name: room.name }))) e.preventDefault();
        }}
      >
        <input type="hidden" name="_action" value="retire" />
        <Button type="submit" variant="destructive" disabled={busy}>
          {t("rooms.edit.retire")}
        </Button>
        <p className="text-muted-foreground mt-1 text-xs">{t("rooms.edit.retireHint")}</p>
      </Form>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
