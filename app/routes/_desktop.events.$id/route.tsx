import { redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/route";
import { requireUser } from "~/lib/auth.server";
import { formDataToObject, safeParse } from "~/lib/validation.server";
import { msgKey, t } from "~/i18n";
import { resolveLocale } from "~/i18n/locale.server";
import {
  BookingConflictError,
  NotFoundError,
  toErrorResponse,
  ValidationError,
} from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { utcToBerlinLocal } from "~/lib/time.server";
import { metaLocale } from "~/i18n/meta";
import { CalendarSyncPanel } from "~/components/events/calendar-sync-panel";
import { getEventDetail, listEventTargets } from "~/domains/events/events.queries.server";
import {
  allocationSchema,
  eventEditSchema,
  roomBookingSchema,
  serviceWindowSchema,
} from "~/domains/events/events.schema";
import {
  addAllocation,
  addRoomBooking,
  addServiceWindow,
  cancelAllocation,
  cancelEvent,
  cancelRoomBooking,
  removeServiceWindow,
  updateEvent,
} from "~/domains/events/events.mutations.server";
import { EventDetailView } from "~/components/events/event-detail";

// Non-empty (trimmed) id for the cancel/remove branches below, which read the
// target id straight off the form rather than through a zod object schema —
// mirrors the validation the sibling add* branches get from safeParse.
const idSchema = z.string().trim().min(1, msgKey("err.idRequired"));

export function meta({ data, matches }: Route.MetaArgs) {
  const locale = metaLocale(matches);
  return [
    {
      title: t(locale, "events.meta.detail", {
        title: data?.detail.event.title ?? t(locale, "events.meta.fallbackTitle"),
      }),
    },
  ];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const locale = resolveLocale(request);
  const detail = await getEventDetail(params.id);
  if (!detail) throw toErrorResponse(new NotFoundError(t(locale, "err.event.notFound")));
  const targets = await listEventTargets();
  const e = detail.event;
  const editDefaults = {
    title: e.title,
    description: e.description,
    startsAt: utcToBerlinLocal(e.startsAt),
    endsAt: utcToBerlinLocal(e.endsAt),
    status: e.status,
    organizer: e.organizer,
    contact: e.contact,
  };
  return {
    detail,
    targets,
    editDefaults,
    slotStart: utcToBerlinLocal(e.startsAt),
    slotEnd: utcToBerlinLocal(e.endsAt),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const actor = await requireUser(request);
  const locale = resolveLocale(request);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  const id = params.id;
  const obj = formDataToObject(form);

  try {
    switch (intent) {
      case "updateEvent": {
        const r = safeParse(eventEditSchema, obj, locale);
        if (!r.success) return { form: "updateEvent", fieldErrors: r.fieldErrors };
        const ev = await updateEvent(actor, id, r.data);
        await emitChange({ entityType: "event", id: ev.id, op: "updated" });
        return redirect(`/events/${id}`);
      }
      case "cancelEvent": {
        const ev = await cancelEvent(actor, id);
        await emitChange({ entityType: "event", id: ev.id, op: "updated" });
        return redirect(`/events/${id}`);
      }
      case "addRoom": {
        const r = safeParse(roomBookingSchema, obj, locale);
        if (!r.success) return { form: "addRoom", fieldErrors: r.fieldErrors };
        try {
          const b = await addRoomBooking(actor, id, r.data);
          await emitChange({ entityType: "eventRoomBooking", id: b.id, op: "created" });
        } catch (e) {
          if (e instanceof BookingConflictError) return { form: "addRoom", error: e.message };
          throw e;
        }
        return redirect(`/events/${id}`);
      }
      case "cancelRoom": {
        const bookingId = safeParse(idSchema, form.get("bookingId") ?? "", locale);
        if (!bookingId.success)
          throw new ValidationError(bookingId.fieldErrors, bookingId.formErrors);
        const b = await cancelRoomBooking(actor, bookingId.data, id);
        await emitChange({ entityType: "eventRoomBooking", id: b.id, op: "updated" });
        return redirect(`/events/${id}`);
      }
      case "addAllocation": {
        const r = safeParse(allocationSchema, obj, locale);
        if (!r.success) return { form: "addAllocation", fieldErrors: r.fieldErrors };
        try {
          const a = await addAllocation(actor, id, r.data);
          await emitChange({ entityType: "equipmentAllocation", id: a.id, op: "created" });
        } catch (e) {
          if (e instanceof BookingConflictError) return { form: "addAllocation", error: e.message };
          throw e;
        }
        return redirect(`/events/${id}`);
      }
      case "cancelAllocation": {
        const allocationId = safeParse(idSchema, form.get("allocationId") ?? "", locale);
        if (!allocationId.success)
          throw new ValidationError(allocationId.fieldErrors, allocationId.formErrors);
        const a = await cancelAllocation(actor, allocationId.data, id);
        await emitChange({ entityType: "equipmentAllocation", id: a.id, op: "updated" });
        return redirect(`/events/${id}`);
      }
      case "addServiceWindow": {
        const r = safeParse(serviceWindowSchema, obj, locale);
        if (!r.success) return { form: "addServiceWindow", fieldErrors: r.fieldErrors };
        const w = await addServiceWindow(actor, id, r.data);
        await emitChange({ entityType: "serviceWindow", id: w.id, op: "created" });
        return redirect(`/events/${id}`);
      }
      case "removeServiceWindow": {
        const windowIdResult = safeParse(idSchema, form.get("windowId") ?? "", locale);
        if (!windowIdResult.success)
          throw new ValidationError(windowIdResult.fieldErrors, windowIdResult.formErrors);
        const windowId = windowIdResult.data;
        await removeServiceWindow(actor, windowId, id);
        await emitChange({ entityType: "serviceWindow", id: windowId, op: "deleted" });
        return redirect(`/events/${id}`);
      }
      default:
        return null;
    }
  } catch (e) {
    if (e instanceof ValidationError)
      return { error: e.formErrors[0] ?? t(locale, "err.invalidInput") };
    // A stale tab can target a since-removed booking/window — Prisma P2025 → clean 404.
    if (e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "P2025") {
      throw toErrorResponse(new NotFoundError(t(locale, "err.entry.notFound")));
    }
    throw toErrorResponse(e);
  }
}

export default function EventDetailRoute({ loaderData, actionData }: Route.ComponentProps) {
  const { detail, targets, editDefaults, slotStart, slotEnd } = loaderData;
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <EventDetailView
        detail={detail}
        targets={targets}
        editDefaults={editDefaults}
        slotStart={slotStart}
        slotEnd={slotEnd}
        actionData={actionData ?? undefined}
      />
      <CalendarSyncPanel sync={detail.calendarSync} />
    </div>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error-boundary";
