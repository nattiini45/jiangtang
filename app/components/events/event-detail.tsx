import { Form, Link } from "react-router";
import { ZodForm, FormField, type FieldErrors } from "~/components/forms";
import { DateCell } from "~/components/data-grid";
import { Badge } from "~/components/ui/badge";
import { Card, CardHeader, CardTitle } from "~/components/ui/card";
import { StatusBadge } from "~/components/ui/status-badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Select } from "~/components/ui/select";
import { EventTimeline } from "~/components/timeline/event-timeline";
import { ConflictCheck } from "~/components/events/conflict-check";
import { ServiceWindowKind } from "~/generated/prisma/enums";
import { ticketTypeLabel } from "~/components/tickets/labels";
import { useLocale, useT } from "~/i18n/use-t";
import type {
  EventDetail as EventDetailData,
  EventTargets,
} from "~/domains/events/events.queries.server";
import { eventStatusLabel, serviceWindowKindLabel } from "./labels";
import { EventFormFields, type EventDefaults } from "./event-form-fields";
import { EventReopenAction } from "./event-reopen-action";

export interface EventActionData {
  form?: string;
  fieldErrors?: FieldErrors;
  error?: string;
}

/** Inline conflict/error banner for a specific sub-form. */
function FormError({ when, actionData }: { when: string; actionData?: EventActionData }) {
  if (actionData?.form !== when || !actionData.error) return null;
  return (
    <p className="bg-destructive/10 text-foreground rounded-md p-2 text-sm" role="alert">
      {actionData.error}
    </p>
  );
}

function errorsFor(when: string, actionData?: EventActionData): FieldErrors | undefined {
  return actionData?.form === when ? actionData.fieldErrors : undefined;
}

export function EventDetailView({
  detail,
  targets,
  editDefaults,
  slotStart,
  slotEnd,
  actionData,
}: {
  detail: EventDetailData;
  targets: EventTargets;
  editDefaults: EventDefaults;
  slotStart: string;
  slotEnd: string;
  actionData?: EventActionData;
}) {
  const t = useT();
  const locale = useLocale();
  const { event, rooms, allocations, serviceWindows, tickets } = detail;
  const cancelled = event.status === "CANCELLED";

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold">{event.title}</h1>
          <StatusBadge kind="event" value={event.status} />
        </div>
        <Link to="/events" className="text-muted-foreground text-sm hover:underline">
          {t("events.back")}
        </Link>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="flex items-center gap-1">
          <DateCell value={event.startsAt} /> – <DateCell value={event.endsAt} />
        </span>
        {event.organizer ? <span>· {event.organizer}</span> : null}
        {event.contact ? <span>· {event.contact}</span> : null}
      </div>
      {event.description ? (
        <p className="whitespace-pre-wrap text-sm">{event.description}</p>
      ) : null}

      {actionData?.error && !actionData.form ? (
        <p className="bg-destructive/10 text-foreground rounded-md p-2 text-sm" role="alert">
          {actionData.error}
        </p>
      ) : null}

      <EventReopenAction status={event.status} />

      {/* Timeline */}
      {rooms.length > 0 || serviceWindows.length > 0 ? (
        <Card className="p-4">
          <p className="mb-3 text-base font-semibold">{t("events.detail.timeline")}</p>
          <EventTimeline
            start={event.startsAt}
            end={event.endsAt}
            rooms={rooms}
            serviceWindows={serviceWindows}
          />
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Rooms */}
        <Card>
          <CardHeader>
            <CardTitle>{t("events.detail.rooms")}</CardTitle>
          </CardHeader>
          {rooms.length === 0 ? (
            <p className="text-muted-foreground px-4 pb-4 text-sm">{t("events.detail.noRooms")}</p>
          ) : (
            <ul className="divide-y">
              {rooms.map((b) => (
                <li key={b.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                  <Link to={`/rooms/${b.roomSlug}`} className="hover:underline">
                    {b.roomName}
                  </Link>
                  <span className="text-muted-foreground ml-auto flex items-center gap-1 text-xs">
                    <DateCell value={b.startsAt} /> – <DateCell value={b.endsAt} />
                  </span>
                  {!cancelled ? (
                    <Form method="post">
                      <input type="hidden" name="_action" value="cancelRoom" />
                      <input type="hidden" name="bookingId" value={b.id} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="compact"
                        title={t("events.detail.cancelRoom")}
                      >
                        ✕
                      </Button>
                    </Form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {!cancelled ? (
            <div className="border-t p-4">
              <FormError when="addRoom" actionData={actionData} />
              <ZodForm
                id="add-room-form"
                method="post"
                fieldErrors={errorsFor("addRoom", actionData)}
                className="gap-2"
              >
                <input type="hidden" name="_action" value="addRoom" />
                <FormField name="roomId" label={t("events.detail.bookRoom")}>
                  <Select name="roomId" defaultValue="">
                    <option value="">{t("events.detail.pickRoom")}</option>
                    {targets.rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <div className="grid grid-cols-2 gap-2">
                  <FormField name="startsAt" label={t("events.detail.from")}>
                    <Input type="datetime-local" name="startsAt" defaultValue={slotStart} />
                  </FormField>
                  <FormField name="endsAt" label={t("events.detail.to")}>
                    <Input type="datetime-local" name="endsAt" defaultValue={slotEnd} />
                  </FormField>
                </div>
                <ConflictCheck kind="room" formId="add-room-form" />
                <Button type="submit" size="compact" className="self-start">
                  {t("events.detail.bookRoom")}
                </Button>
              </ZodForm>
            </div>
          ) : null}
        </Card>

        {/* Allocations */}
        <Card>
          <CardHeader>
            <CardTitle>{t("events.detail.pooledEquipment")}</CardTitle>
          </CardHeader>
          {allocations.length === 0 ? (
            <p className="text-muted-foreground px-4 pb-4 text-sm">
              {t("events.detail.noAllocations")}
            </p>
          ) : (
            <ul className="divide-y">
              {allocations.map((a) => (
                <li key={a.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                  <Link to={`/inventory/${a.equipmentId}`} className="hover:underline">
                    {a.equipmentName}
                  </Link>
                  <span className="text-muted-foreground ml-auto flex items-center gap-1 text-xs">
                    <DateCell value={a.startsAt} /> – <DateCell value={a.endsAt} />
                  </span>
                  {!cancelled ? (
                    <Form method="post">
                      <input type="hidden" name="_action" value="cancelAllocation" />
                      <input type="hidden" name="allocationId" value={a.id} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="compact"
                        title={t("events.detail.cancelAllocation")}
                      >
                        ✕
                      </Button>
                    </Form>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {!cancelled ? (
            <div className="border-t p-4">
              <FormError when="addAllocation" actionData={actionData} />
              <ZodForm
                id="add-allocation-form"
                method="post"
                fieldErrors={errorsFor("addAllocation", actionData)}
                className="gap-2"
              >
                <input type="hidden" name="_action" value="addAllocation" />
                <FormField name="equipmentId" label={t("events.detail.allocateEquipment")}>
                  <Select name="equipmentId" defaultValue="">
                    <option value="">{t("events.detail.pickPooledEquipment")}</option>
                    {targets.pooledEquipment.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <div className="grid grid-cols-2 gap-2">
                  <FormField name="startsAt" label={t("events.detail.from")}>
                    <Input type="datetime-local" name="startsAt" defaultValue={slotStart} />
                  </FormField>
                  <FormField name="endsAt" label={t("events.detail.to")}>
                    <Input type="datetime-local" name="endsAt" defaultValue={slotEnd} />
                  </FormField>
                </div>
                <ConflictCheck kind="equipment" formId="add-allocation-form" />
                <Button type="submit" size="compact" className="self-start">
                  {t("events.detail.allocateEquipment")}
                </Button>
              </ZodForm>
            </div>
          ) : null}
        </Card>
      </div>

      {/* Service windows */}
      <Card>
        <CardHeader>
          <CardTitle>{t("events.detail.serviceWindows")}</CardTitle>
        </CardHeader>
        {serviceWindows.length === 0 ? (
          <p className="text-muted-foreground px-4 pb-4 text-sm">
            {t("events.detail.noServiceWindows")}
          </p>
        ) : (
          <ul className="divide-y">
            {serviceWindows.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                <Badge>{serviceWindowKindLabel(locale, w.kind)}</Badge>
                {w.roomName ? <span>{w.roomName}</span> : null}
                {w.covering ? <span>{w.covering}</span> : null}
                {w.notes ? <span className="text-muted-foreground">— {w.notes}</span> : null}
                <span className="text-muted-foreground ml-auto flex items-center gap-1 text-xs">
                  <DateCell value={w.startsAt} /> – <DateCell value={w.endsAt} />
                </span>
                {!cancelled ? (
                  <Form method="post">
                    <input type="hidden" name="_action" value="removeServiceWindow" />
                    <input type="hidden" name="windowId" value={w.id} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="compact"
                      title={t("events.detail.removeServiceWindow")}
                    >
                      ✕
                    </Button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {!cancelled ? (
          <div className="border-t p-4">
            <ZodForm
              method="post"
              fieldErrors={errorsFor("addServiceWindow", actionData)}
              className="gap-2"
            >
              <input type="hidden" name="_action" value="addServiceWindow" />
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <FormField name="kind" label={t("events.detail.windowKind")}>
                  <Select name="kind" defaultValue={ServiceWindowKind.SETUP}>
                    {Object.values(ServiceWindowKind).map((k) => (
                      <option key={k} value={k}>
                        {serviceWindowKindLabel(locale, k)}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  name="roomId"
                  label={t("events.detail.windowRoom")}
                  hint={t("common.optional")}
                >
                  <Select name="roomId" defaultValue="">
                    <option value="">{t("events.detail.noRoom")}</option>
                    {targets.rooms.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField name="startsAt" label={t("events.detail.from")}>
                  <Input type="datetime-local" name="startsAt" defaultValue={slotStart} />
                </FormField>
                <FormField name="endsAt" label={t("events.detail.to")}>
                  <Input type="datetime-local" name="endsAt" defaultValue={slotEnd} />
                </FormField>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <FormField
                  name="coveringUserId"
                  label={t("events.detail.covering")}
                  hint={t("common.optional")}
                >
                  <Select name="coveringUserId" defaultValue="">
                    <option value="">{t("tickets.form.noOne")}</option>
                    {targets.users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                        {u.initials ? ` (${u.initials})` : ""}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField
                  name="notes"
                  label={t("events.detail.notes")}
                  hint={t("common.optional")}
                >
                  <Input name="notes" />
                </FormField>
              </div>
              <Button type="submit" size="compact" className="self-start">
                {t("events.detail.addServiceWindow")}
              </Button>
            </ZodForm>
          </div>
        ) : null}
      </Card>

      {/* Tickets */}
      <Card>
        <CardHeader>
          <CardTitle>{t("events.detail.tickets")}</CardTitle>
          <Button asChild size="compact" variant="ghost">
            <Link to={`/tickets/new?eventId=${event.id}`}>{t("events.detail.addTicket")}</Link>
          </Button>
        </CardHeader>
        {tickets.length === 0 ? (
          <p className="text-muted-foreground px-4 pb-4 text-sm">{t("events.detail.noTickets")}</p>
        ) : (
          <ul className="divide-y">
            {tickets.map((ticket) => (
              <li key={ticket.id} className="flex items-center gap-2 px-4 py-2 text-sm">
                <span className="text-muted-foreground text-xs">
                  {ticketTypeLabel(locale, ticket.type)}
                </span>
                <Link to={`/tickets/${ticket.id}`} className="truncate hover:underline">
                  {ticket.title}
                </Link>
                <span className="ml-auto">
                  <StatusBadge kind="ticket" value={ticket.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Edit + cancel */}
      {!cancelled ? (
        <details className="bg-card shadow-surface-2 rounded-lg p-4">
          <summary className="cursor-pointer text-base font-semibold">
            {t("events.detail.edit")}
          </summary>
          <ZodForm
            method="post"
            fieldErrors={errorsFor("updateEvent", actionData)}
            className="mt-4"
          >
            <input type="hidden" name="_action" value="updateEvent" />
            <input
              type="hidden"
              name="startsAtInstant"
              value={new Date(event.startsAt).toISOString()}
            />
            <input
              type="hidden"
              name="endsAtInstant"
              value={new Date(event.endsAt).toISOString()}
            />
            <EventFormFields defaults={editDefaults} />
            <Button type="submit">{t("events.detail.saveChanges")}</Button>
          </ZodForm>

          <Form
            method="post"
            className="mt-4 border-t pt-4"
            onSubmit={(e) => {
              if (!confirm(t("events.detail.confirmCancel", { title: event.title })))
                e.preventDefault();
            }}
          >
            <input type="hidden" name="_action" value="cancelEvent" />
            <Button type="submit" variant="destructive">
              {t("events.detail.cancelEvent")}
            </Button>
            <p className="text-muted-foreground mt-1 text-xs">{t("events.detail.cancelHint")}</p>
          </Form>
        </details>
      ) : (
        <p className="text-muted-foreground text-sm">
          {t("events.detail.cancelledNote", { status: eventStatusLabel(locale, event.status) })}
        </p>
      )}
    </div>
  );
}
