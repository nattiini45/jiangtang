import * as React from "react";
import { data, Link, redirect, useFetcher, useNavigation } from "react-router";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import {
  BookingConflictError,
  toErrorResponse,
  TransitionError,
  ValidationError,
} from "~/lib/errors.server";
import { HealthOverrideFields } from "~/components/events/health-override-fields";
import { healthOverrideFromForm, roomBookingAction } from "~/domains/events/events.health-policy";
import { resolveLocale } from "~/i18n/locale.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { eventCreateSchema, roomBookingCreateSchema } from "~/domains/events/events.schema";
import { createEvent, createEventWithBooking } from "~/domains/events/events.mutations.server";
import { eventCreationPrefill } from "~/domains/events/events.prefill.server";
import { eventStartWeekday, eventTimeMs } from "~/domains/events/events.time";
import { listRooms } from "~/domains/rooms/rooms.queries.server";
import { ZodForm, FormField } from "~/components/forms";
import { EventFormFields } from "~/components/events/event-form-fields";
import { EventRecurrenceFields, EventSeriesResult } from "~/components/events/event-series-fields";
import { eventSeriesSchema, seriesEventSchema } from "~/domains/events/event-series.schema";
import { createEventSeries } from "~/domains/events/event-series.mutations.server";
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
  const form = await request.formData();
  const obj = healthOverrideFromForm(formDataToObject(form));
  const frequency = form.get("frequency");
  if (frequency !== null && frequency !== "once") {
    const event = safeParse(
      seriesEventSchema,
      {
        ...obj,
        startsAtInstant: undefined,
        endsAtInstant: undefined,
      },
      locale,
    );
    if (!event.success)
      return {
        fieldErrors: {
          ...event.fieldErrors,
          ...(event.fieldErrors.status
            ? { status: [t(locale, "events.series.activeStatus")] }
            : {}),
        },
      };
    const weekdays = form.getAll("weekdays").map(Number);
    const endKind = form.get("endKind");
    const interval = Number(form.get("interval"));
    const count = Number(form.get("count"));
    const endDate = form.get("endDate");
    if (frequency === "weekly") {
      const fieldErrors: Record<string, string[]> = {};
      if (!Number.isInteger(interval) || interval < 1 || interval > 52) {
        fieldErrors.interval = [t(locale, "events.series.validInterval")];
      }
      if (
        !weekdays.includes(eventStartWeekday(event.data.startsAt)) ||
        weekdays.length > 7 ||
        weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
      ) {
        fieldErrors.weekdays = [t(locale, "events.series.chooseWeekday")];
      }
      if (Object.keys(fieldErrors).length) return { fieldErrors };
    }
    const result = safeParse(
      eventSeriesSchema,
      {
        event: event.data,
        rule: { frequency, weekdays, interval },
        end: { kind: endKind, date: endDate, count },
        rooms: obj.roomId ? [obj] : [],
      },
      locale,
    );
    if (!result.success) {
      const invalid = [t(locale, "err.invalidInput")];
      const fieldErrors = {
        ...(result.fieldErrors.rule ? { frequency: invalid } : {}),
        ...(result.fieldErrors.end
          ? endKind === "date"
            ? { endDate: [t(locale, "events.series.validEndDate")] }
            : { count: invalid }
          : {}),
        ...(result.fieldErrors.rooms ? { roomId: invalid } : {}),
      };
      return { fieldErrors };
    }
    try {
      const seriesResult = await createEventSeries(actor, result.data);
      return { seriesResult, fieldErrors: undefined };
    } catch (error) {
      if (error instanceof ValidationError)
        return data({ fieldErrors: error.fieldErrors }, { status: 422 });
      throw toErrorResponse(error);
    }
  }
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
    if (e instanceof TransitionError)
      return data({ fieldErrors: e.fieldErrors, transition: e.transition }, { status: 422 });
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
  const [frequency, setFrequency] = React.useState("once");
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
    frequency === "once" &&
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
  const seriesResult =
    actionData && "seriesResult" in actionData ? actionData.seriesResult : undefined;
  if (seriesResult) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <h1 className="text-xl font-bold">{t("events.series.result")}</h1>
        <EventSeriesResult result={seriesResult} />
      </div>
    );
  }
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
        <EventFormFields
          defaults={defaults}
          scheduling={
            <EventRecurrenceFields
              start={window.startsAt}
              frequency={frequency}
              onFrequencyChange={setFrequency}
            />
          }
        />
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
        <HealthOverrideFields
          key={window.roomId}
          entity="room"
          action={roomBookingAction(
            rooms.find((room) => room.id === window.roomId)?.status ?? "ALL_GOOD",
          )}
        />
        {conflicts.length > 0 || (actionData && "conflict" in actionData && actionData.conflict) ? (
          <p className="text-status-fault text-sm" role="alert">
            {t("mobile.eventsNew.conflict")}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {busy
              ? t("common.creating")
              : t(frequency === "once" ? "events.new.submit" : "events.series.submit")}
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
