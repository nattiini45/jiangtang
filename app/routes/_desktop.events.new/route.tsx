import * as React from "react";
import { Link, redirect, useFetcher, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { BookingConflictError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { resolveLocale } from "~/i18n/locale.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { eventCreateSchema, roomBookingCreateSchema } from "~/domains/events/events.schema";
import { createEvent, createEventWithBooking } from "~/domains/events/events.mutations.server";
import { eventCreationPrefill } from "~/domains/events/events.prefill.server";
import { eventTimeMs } from "~/domains/events/events.time";
import { listRooms } from "~/domains/rooms/rooms.queries.server";
import { ZodForm, FormField } from "~/components/forms";
import { EventFormFields } from "~/components/events/event-form-fields";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/select";
import { t } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

export function meta({ matches }: Route.MetaArgs) {
  return [{ title: t(metaLocale(matches), "events.meta.new") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  try {
    const rooms = await listRooms();
    return { rooms, defaults: eventCreationPrefill(new URL(request.url).searchParams, rooms) };
  } catch (e) {
    throw toErrorResponse(e);
  }
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const obj = formDataToObject(await request.formData());
  const result = safeParse(eventCreateSchema, obj, locale);
  if (!result.success) return { fieldErrors: result.fieldErrors };
  const booking = obj.roomId ? safeParse(roomBookingCreateSchema, obj, locale) : undefined;
  if (booking && !booking.success) return { fieldErrors: booking.fieldErrors };
  try {
    const event = booking?.success
      ? await createEventWithBooking(actor, result.data, booking.data)
      : await createEvent(actor, result.data);
    await emitChange({ entityType: "event", id: event.id, op: "created" });
    return redirect(`/events/${event.id}`);
  } catch (e) {
    if (e instanceof BookingConflictError) return { conflict: true, fieldErrors: undefined };
    if (e instanceof ValidationError) return { fieldErrors: e.fieldErrors };
    throw toErrorResponse(e);
  }
}

export default function NewEvent({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  const t = useT();
  const { rooms, defaults } = loaderData;
  const [window, setWindow] = React.useState(defaults);
  const checkId = React.useId();
  const params = new URLSearchParams({
    kind: "room",
    id: window.roomId,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
  });
  if (defaults.startsAtInstant) params.set("startsAtInstant", defaults.startsAtInstant);
  if (defaults.endsAtInstant) params.set("endsAtInstant", defaults.endsAtInstant);
  const checkUrl =
    window.roomId &&
    window.startsAt &&
    window.endsAt &&
    eventTimeMs(window.startsAt, defaults.startsAtInstant) <
      eventTimeMs(window.endsAt, defaults.endsAtInstant)
      ? `/api/events/check-conflict?${params.toString()}`
      : "";
  const fetcher = useFetcher<{ conflicts: unknown[] }>({ key: `${checkId}:${checkUrl}` });
  const loadConflicts = fetcher.load;
  React.useEffect(() => {
    if (checkUrl) void loadConflicts(checkUrl);
  }, [checkUrl, loadConflicts]);
  const conflicts = checkUrl && fetcher.state === "idle" ? (fetcher.data?.conflicts ?? []) : [];
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-bold">{t("events.new.title")}</h1>
        <Link to="/events" className="text-muted-foreground text-sm hover:underline">
          {t("events.back")}
        </Link>
      </div>
      <ZodForm
        method="post"
        fieldErrors={actionData?.fieldErrors}
        onChange={(event) => {
          const form = new FormData(event.currentTarget);
          setWindow({
            ...defaults,
            roomId: String(form.get("roomId") ?? ""),
            startsAt: String(form.get("startsAt") ?? ""),
            endsAt: String(form.get("endsAt") ?? ""),
          });
        }}
      >
        {defaults.startsAtInstant ? (
          <input type="hidden" name="startsAtInstant" value={defaults.startsAtInstant} />
        ) : null}
        {defaults.endsAtInstant ? (
          <input type="hidden" name="endsAtInstant" value={defaults.endsAtInstant} />
        ) : null}
        <EventFormFields defaults={defaults} />
        <FormField name="roomId" label={t("events.detail.windowRoom")} hint={t("common.optional")}>
          <Select name="roomId" defaultValue={defaults.roomId}>
            <option value="">{t("events.detail.noRoom")}</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </Select>
        </FormField>
        {conflicts.length > 0 || (actionData && "conflict" in actionData && actionData.conflict) ? (
          <p className="text-status-fault text-sm" role="alert">
            {t("mobile.eventsNew.conflict")}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy ? t("common.creating") : t("events.new.submit")}
          </Button>
          <Button asChild variant="ghost">
            <Link to="/events">{t("common.cancel")}</Link>
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
