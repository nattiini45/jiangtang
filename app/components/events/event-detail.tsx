import { Form, Link } from "react-router";
import { ZodForm, FormField, type FieldErrors } from "~/components/forms";
import { DateCell } from "~/components/data-grid";
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

export interface EventActionData {
  form?: string;
  fieldErrors?: FieldErrors;
  error?: string;
}

/** Inline conflict/error banner for a specific sub-form. */
function FormError({ when, actionData }: { when: string; actionData?: EventActionData }) {
  if (actionData?.form !== when || !actionData.error) return null;
  return (
    <p
      className="border-status-fault/40 bg-status-fault/10 text-status-fault border p-2 text-sm"
      role="alert"
    >
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
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="font-mono text-xl">{event.title}</h1>
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
        <p
          className="border-status-fault/40 bg-status-fault/10 text-status-fault border p-2 text-sm"
          role="alert"
        >
          {actionData.error}
        </p>
      ) : null}

      {/* Timeline */}
      {rooms.length > 0 || serviceWindows.length > 0 ? (
        <section className="border-border border p-3">
          <p className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
            {t("events.detail.timeline")}
          </p>
          <EventTimeline
            start={event.startsAt}
            end={event.endsAt}
            rooms={rooms}
            serviceWindows={serviceWindows}
          />
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Rooms */}
        <section className="border-border border">
          <header className="border-border border-b px-3 py-2">
            <h2 className="text-sm font-medium">{t("events.detail.rooms")}</h2>
          </header>
          {rooms.length === 0 ? (
            <p className="text-muted-foreground p-3 text-sm">{t("events.detail.noRooms")}</p>
          ) : (
            <ul className="divide-border divide-y">
              {rooms.map((b) => (
                <li key={b.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <Link to={`/rooms/${b.roomSlug}`} className="hover:underline">
                    {b.roomName}
                  </Link>
                  <span className="text-muted-foreground ml-auto flex items-center gap-1 font-mono text-xs">
                    <DateCell value={b.startsAt} /> – <DateCell value={b.endsAt} />
                  </span>
                  {!cancelled ? (
                    <Form method="post">
                      <input type="hidden" name="_action" value="cancelRoom" />
                      <input type="hidden" name="bookingId" value={b.id} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
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
            <div className="border-border border-t p-3">
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
                <Button type="submit" size="sm" className="self-start">
                  {t("events.detail.bookRoom")}
                </Button>
              </ZodForm>
            </div>
          ) : null}
        </section>

        {/* Allocations */}
        <section className="border-border border">
          <header className="border-border border-b px-3 py-2">
            <h2 className="text-sm font-medium">{t("events.detail.pooledEquipment")}</h2>
          </header>
          {allocations.length === 0 ? (
            <p className="text-muted-foreground p-3 text-sm">{t("events.detail.noAllocations")}</p>
          ) : (
            <ul className="divide-border divide-y">
              {allocations.map((a) => (
                <li key={a.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <Link to={`/inventory/${a.equipmentId}`} className="hover:underline">
                    {a.equipmentName}
                  </Link>
                  <span className="text-muted-foreground ml-auto flex items-center gap-1 font-mono text-xs">
                    <DateCell value={a.startsAt} /> – <DateCell value={a.endsAt} />
                  </span>
                  {!cancelled ? (
                    <Form method="post">
                      <input type="hidden" name="_action" value="cancelAllocation" />
                      <input type="hidden" name="allocationId" value={a.id} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="sm"
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
            <div className="border-border border-t p-3">
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
                <Button type="submit" size="sm" className="self-start">
                  {t("events.detail.allocateEquipment")}
                </Button>
              </ZodForm>
            </div>
          ) : null}
        </section>
      </div>

      {/* Service windows */}
      <section className="border-border border">
        <header className="border-border border-b px-3 py-2">
          <h2 className="text-sm font-medium">{t("events.detail.serviceWindows")}</h2>
        </header>
        {serviceWindows.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm">{t("events.detail.noServiceWindows")}</p>
        ) : (
          <ul className="divide-border divide-y">
            {serviceWindows.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="border-border bg-secondary rounded-sm border px-1.5 py-0.5 text-xs">
                  {serviceWindowKindLabel(locale, w.kind)}
                </span>
                {w.roomName ? <span>{w.roomName}</span> : null}
                {w.covering ? <span className="font-mono text-xs">{w.covering}</span> : null}
                {w.notes ? <span className="text-muted-foreground">— {w.notes}</span> : null}
                <span className="text-muted-foreground ml-auto flex items-center gap-1 font-mono text-xs">
                  <DateCell value={w.startsAt} /> – <DateCell value={w.endsAt} />
                </span>
                {!cancelled ? (
                  <Form method="post">
                    <input type="hidden" name="_action" value="removeServiceWindow" />
                    <input type="hidden" name="windowId" value={w.id} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
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
          <div className="border-border border-t p-3">
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
              <Button type="submit" size="sm" className="self-start">
                {t("events.detail.addServiceWindow")}
              </Button>
            </ZodForm>
          </div>
        ) : null}
      </section>

      {/* Tickets */}
      <section className="border-border border">
        <header className="border-border flex items-center justify-between border-b px-3 py-2">
          <h2 className="text-sm font-medium">{t("events.detail.tickets")}</h2>
          <Button asChild size="sm" variant="ghost">
            <Link to={`/tickets/new?eventId=${event.id}`}>{t("events.detail.addTicket")}</Link>
          </Button>
        </header>
        {tickets.length === 0 ? (
          <p className="text-muted-foreground p-3 text-sm">{t("events.detail.noTickets")}</p>
        ) : (
          <ul className="divide-border divide-y">
            {tickets.map((ticket) => (
              <li key={ticket.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="text-muted-foreground font-mono text-xs">
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
      </section>

      {/* Edit + cancel */}
      {!cancelled ? (
        <details className="border-border border p-3">
          <summary className="text-muted-foreground cursor-pointer text-xs uppercase tracking-wide">
            {t("events.detail.edit")}
          </summary>
          <ZodForm
            method="post"
            fieldErrors={errorsFor("updateEvent", actionData)}
            className="mt-3"
          >
            <input type="hidden" name="_action" value="updateEvent" />
            <EventFormFields defaults={editDefaults} />
            <Button type="submit">{t("events.detail.saveChanges")}</Button>
          </ZodForm>

          <Form
            method="post"
            className="border-border mt-4 border-t pt-4"
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
