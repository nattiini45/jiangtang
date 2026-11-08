import * as React from "react";
import { Link, redirect, useFetcher, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { resolveLocale } from "~/i18n/locale.server";
import { BookingConflictError, toErrorResponse, ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { berlinLocalToUtc } from "~/lib/time.server";
import { eventCreateSchema, roomBookingSchema } from "~/domains/events/events.schema";
import { createEventWithBooking } from "~/domains/events/events.mutations.server";
import { findRoomConflicts } from "~/domains/events/events.availability.server";
import { notifyBookingConflict } from "~/domains/notifications/notifications.mutations.server";
import { listRooms } from "~/domains/rooms/rooms.queries.server";
import { ZodForm, FormField } from "~/components/forms";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { dayIndexToDateKey, berlinDayIndex } from "~/lib/berlin-days";
import { RouteErrorBoundary } from "~/components/route-error-boundary";
import { t as translate } from "~/i18n";
import { metaLocale } from "~/i18n/meta";
import { useT } from "~/i18n/use-t";

/**
 * Mobile booking create — one form: event + room + window. The conflict check
 * runs twice: the fetcher polls `/api/events/check-conflict` as the user edits
 * (inline badge before submit), and the action re-checks server-side before
 * inserting — the GiST EXCLUDE constraint stays the authority either way.
 */
export function meta({ matches }: Route.MetaArgs) {
  return [{ title: translate(metaLocale(matches), "mobile.meta.eventsNew") }];
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request);
  const rooms = await listRooms();
  return {
    rooms,
    today: dayIndexToDateKey(berlinDayIndex(new Date())),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const obj = formDataToObject(await request.formData());
  const startsAt = `${obj.date}T${obj.startTime}`;
  const endsAt = `${obj.date}T${obj.endTime}`;

  const eventParsed = safeParse(eventCreateSchema, { ...obj, startsAt, endsAt }, locale);
  const bookingParsed = safeParse(
    roomBookingSchema,
    { roomId: obj.roomId, startsAt, endsAt },
    locale,
  );
  if (!eventParsed.success || !bookingParsed.success) {
    return {
      fieldErrors: {
        ...(!eventParsed.success ? eventParsed.fieldErrors : {}),
        ...(!bookingParsed.success ? bookingParsed.fieldErrors : {}),
      },
    };
  }

  try {
    const startsUtc = berlinLocalToUtc(startsAt);
    const endsUtc = berlinLocalToUtc(endsAt);
    const conflicts = await findRoomConflicts(bookingParsed.data.roomId, startsUtc, endsUtc);
    if (conflicts.length > 0) {
      return { conflict: true, fieldErrors: undefined };
    }
    try {
      // Event + booking in ONE transaction: a GiST conflict rolls both back,
      // so a rejected booking never leaves an orphan event behind.
      const event = await createEventWithBooking(actor, eventParsed.data, bookingParsed.data);
      await emitChange({ entityType: "event", id: event.id, op: "created" });
      return redirect("/m/events");
    } catch (e) {
      // The pre-check passed but the EXCLUDE constraint still fired (race window):
      // report it as a conflict instead of a 409 error boundary. The transaction
      // rolled back, so there is no event to clean up; the user retries another slot.
      if (e instanceof BookingConflictError) {
        const startsUtc = berlinLocalToUtc(startsAt);
        const endsUtc = berlinLocalToUtc(endsAt);
        try {
          const conflicts = await findRoomConflicts(bookingParsed.data.roomId, startsUtc, endsUtc);
          await notifyBookingConflict({
            actor,
            entityType: "eventRoomBooking",
            entityId: null,
            conflictingEventIds: conflicts.map((c) => c.eventId),
            detail: {
              roomId: bookingParsed.data.roomId,
              startsAt: startsUtc.toISOString(),
              endsAt: endsUtc.toISOString(),
              conflicts: conflicts.map((c) => ({ eventId: c.eventId, eventTitle: c.eventTitle })),
            },
          });
        } catch (notifyError) {
          console.error(
            "[m.events.new] conflict notification failed:",
            (notifyError as Error).message,
          );
        }
        return { conflict: true, fieldErrors: undefined };
      }
      throw e;
    }
  } catch (e) {
    if (e instanceof ValidationError) {
      return { conflict: false, fieldErrors: e.fieldErrors };
    }
    throw toErrorResponse(e);
  }
}

export default function MobileEventNew({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT();
  const nav = useNavigation();
  const fetcher = useFetcher<{ conflicts: unknown[] }>();
  const busy = nav.state !== "idle";
  const { rooms, today } = loaderData;

  const [roomId, setRoomId] = React.useState("");
  const [date, setDate] = React.useState(today);
  const [startTime, setStartTime] = React.useState("");
  const [endTime, setEndTime] = React.useState("");

  // Pre-save conflict badge: poll the shared check-conflict resource as the
  // room/window changes (debounced by React's render batching).
  const startsAt = date && startTime ? `${date}T${startTime}` : "";
  const endsAt = date && endTime ? `${date}T${endTime}` : "";
  React.useEffect(() => {
    if (!roomId || !startsAt || !endsAt) return;
    const params = new URLSearchParams({ kind: "room", id: roomId, startsAt, endsAt });
    void fetcher.load(`/api/events/check-conflict?${params.toString()}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, startsAt, endsAt]);

  const conflicts = fetcher.data?.conflicts ?? [];

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("mobile.eventsNew.title")}</h1>
        <Link to="/m/events" className="text-muted-foreground text-sm hover:underline">
          {t("mobile.events.back")}
        </Link>
      </div>

      <ZodForm method="post" fieldErrors={actionData?.fieldErrors} className="flex flex-col gap-3">
        <FormField name="title" label={t("mobile.capture.fieldTitle")}>
          <Input name="title" required placeholder={t("mobile.eventsNew.titlePlaceholder")} />
        </FormField>
        <FormField name="roomId" label={t("mobile.entry.room")}>
          <Select
            name="roomId"
            required
            value={roomId}
            onChange={(e) => setRoomId(e.currentTarget.value)}
            aria-label={t("mobile.entry.room")}
          >
            <option value="">{t("mobile.entry.roomPlaceholder")}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="flex flex-wrap items-end gap-2">
          <FormField name="date" label={t("mobile.eventsNew.date")}>
            <Input
              type="date"
              name="date"
              required
              value={date}
              onChange={(e) => setDate(e.currentTarget.value)}
              className="w-[9.5rem]"
            />
          </FormField>
          <FormField name="startTime" label={t("mobile.eventsNew.start")}>
            <Input
              type="time"
              name="startTime"
              required
              className="w-[6.5rem]"
              onChange={(e) => setStartTime(e.currentTarget.value)}
            />
          </FormField>
          <span className="text-muted-foreground pb-2">–</span>
          <FormField name="endTime" label={t("mobile.eventsNew.end")}>
            <Input
              type="time"
              name="endTime"
              required
              className="w-[6.5rem]"
              onChange={(e) => setEndTime(e.currentTarget.value)}
            />
          </FormField>
        </div>

        {conflicts.length > 0 ? (
          <p className="text-status-fault text-sm" role="alert">
            {t("mobile.eventsNew.conflict")}
          </p>
        ) : null}
        {actionData && "conflict" in actionData && actionData.conflict ? (
          <p className="text-status-fault text-sm" role="alert">
            {t("mobile.eventsNew.conflict")}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" disabled={busy || conflicts.length > 0} className="min-h-11 flex-1">
            {busy ? t("common.creating") : t("mobile.eventsNew.submit")}
          </Button>
        </div>
      </ZodForm>
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary };
