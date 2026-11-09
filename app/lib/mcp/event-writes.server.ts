import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { msgKey } from "~/i18n";
import { tr } from "~/i18n/request-locale.server";
import {
  eventCreateSchema,
  eventEditSchema,
  roomBookingExactSchema,
  allocationSchema,
  serviceWindowSchema,
} from "~/domains/events/events.schema";
import {
  createEvent,
  createEventWithBooking,
  updateEvent,
  cancelEvent,
  addRoomBooking,
  cancelRoomBooking,
  addAllocation,
  cancelAllocation,
  addServiceWindow,
  removeServiceWindow,
} from "~/domains/events/events.mutations.server";
import { getEventDetail } from "~/domains/events/events.queries.server";
import {
  findRoomConflicts,
  findEquipmentConflicts,
} from "~/domains/events/events.availability.server";
import {
  ticketCreateSchema,
  ticketEditSchema,
  ticketTransitionSchema,
} from "~/domains/tickets/tickets.schema";
import {
  createTicket,
  updateTicket,
  transitionTicket,
  moveTicketToLane,
} from "~/domains/tickets/tickets.mutations.server";
import { LANES } from "~/domains/tasks/tasks.lanes";
import { berlinLocalString } from "~/lib/berlin-days";
import { BookingConflictError, NotFoundError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { registerTool } from "~/lib/mcp/tools.server";
import { ticketActionMetadata } from "~/domains/tickets/tickets.transitions";
import { mcpActor, type McpContext } from "~/lib/mcp/types.server";

const id = z.string().trim().min(1).max(200);
const confirm = z.literal(true);
const instant = z.iso.datetime({ offset: true });
const instantFields = {
  startsAt: instant,
  endsAt: instant,
  startsAtInstant: z.never().optional(),
  endsAtInstant: z.never().optional(),
};
const eventInput = eventCreateSchema
  .safeExtend(instantFields)
  .refine((input) => input.status !== "CANCELLED", {
    path: ["status"],
    message: msgKey("err.mcp.createActiveEvent"),
  });
const bookingInput = roomBookingExactSchema.safeExtend(instantFields);
const allocationInput = allocationSchema.safeExtend(instantFields);
const windowInput = serviceWindowSchema.safeExtend(instantFields);
const ticketDates = { occurredAt: instant.optional(), resolvedAt: instant.optional() };

function eventTimes<T extends { startsAt: string; endsAt: string }>(input: T) {
  return {
    ...input,
    startsAt: berlinLocalString(input.startsAt).replace(" ", "T"),
    endsAt: berlinLocalString(input.endsAt).replace(" ", "T"),
    startsAtInstant: new Date(input.startsAt).toISOString(),
    endsAtInstant: new Date(input.endsAt).toISOString(),
  };
}

async function eventDetail(eventId: string) {
  const detail = await getEventDetail(eventId);
  if (!detail) throw new NotFoundError();
  return detail;
}

async function withBookingConflict<T>(
  kind: "room" | "equipment",
  resourceId: string,
  input: { startsAt: string; endsAt: string },
  mutate: () => Promise<T>,
): Promise<T> {
  try {
    return await mutate();
  } catch (error) {
    if (!(error instanceof BookingConflictError)) throw error;
    let conflicts;
    try {
      const startsAt = new Date(input.startsAt);
      const endsAt = new Date(input.endsAt);
      conflicts =
        kind === "room"
          ? await findRoomConflicts(resourceId, startsAt, endsAt)
          : await findEquipmentConflicts(resourceId, startsAt, endsAt);
    } catch {
      throw error;
    }
    const detail = conflicts.map((conflict) =>
      tr(
        "bookingId" in conflict
          ? "err.mcp.bookingConflictDetail"
          : "err.mcp.allocationConflictDetail",
        {
          eventTitle: conflict.eventTitle,
          eventId: conflict.eventId,
          reservationId: "bookingId" in conflict ? conflict.bookingId : conflict.allocationId,
          startsAt: conflict.startsAt.toISOString(),
          endsAt: conflict.endsAt.toISOString(),
        },
      ),
    );
    throw new BookingConflictError([error.message, ...detail].join("\n"));
  }
}

export function registerEventWrites(server: McpServer, ctx: McpContext): void {
  registerTool(
    server,
    ctx,
    {
      name: "create_event",
      description: "Create an event. startsAt and endsAt must be ISO instants with a timezone.",
      schema: z.object({ input: eventInput }),
      write: true,
    },
    async ({ input }, context) => {
      const event = await createEvent(
        mcpActor(context),
        eventCreateSchema.parse(eventTimes(input)),
      );
      await emitChange({ entityType: "event", id: event.id, op: "created" });
      return { ...event, label: event.title };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "create_event_with_booking",
      description: "Create an event and initial room booking atomically. A conflict saves neither.",
      schema: z.object({ input: eventInput, booking: bookingInput }),
      write: true,
    },
    async ({ input, booking }, context) => {
      const event = await withBookingConflict("room", booking.roomId, booking, () =>
        createEventWithBooking(
          mcpActor(context),
          eventCreateSchema.parse(eventTimes(input)),
          roomBookingExactSchema.parse(eventTimes(booking)),
        ),
      );
      await emitChange({ entityType: "event", id: event.id, op: "created" });
      const detail = await eventDetail(event.id);
      for (const room of detail.rooms) {
        await emitChange({ entityType: "eventRoomBooking", id: room.id, op: "created" });
      }
      return { ...event, label: event.title, bookings: detail.rooms };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "update_event",
      description:
        "Replace event content and status. Requires confirm:true because cancellation frees bookings.",
      schema: z.object({ id, input: eventEditSchema.safeExtend(instantFields), confirm }),
      write: true,
      destructive: true,
    },
    async ({ id, input }, context) => {
      const event = await updateEvent(
        mcpActor(context),
        id,
        eventEditSchema.parse(eventTimes(input)),
      );
      await emitChange({ entityType: "event", id: event.id, op: "updated" });
      return { ...event, label: event.title };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "cancel_event",
      description:
        "Cancel an event and release its room and equipment bookings. Requires confirm:true.",
      schema: z.object({ id, confirm }),
      write: true,
      destructive: true,
    },
    async ({ id }, context) => {
      const event = await cancelEvent(mcpActor(context), id);
      await emitChange({ entityType: "event", id: event.id, op: "updated" });
      return { ...event, label: event.title };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "add_room_booking",
      description: "Book a room for an event. The database rejects overlapping bookings.",
      schema: z.object({ eventId: id, input: bookingInput }),
      write: true,
    },
    async ({ eventId, input }, context) => {
      const detail = await eventDetail(eventId);
      const booking = await withBookingConflict("room", input.roomId, input, () =>
        addRoomBooking(mcpActor(context), eventId, roomBookingExactSchema.parse(eventTimes(input))),
      );
      await emitChange({ entityType: "eventRoomBooking", id: booking.id, op: "created" });
      await emitChange({ entityType: "event", id: eventId, op: "updated" });
      return { ...booking, label: detail.event.title };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "cancel_room_booking",
      description: "Cancel a room booking belonging to this event. Requires confirm:true.",
      schema: z.object({ eventId: id, id, confirm }),
      write: true,
      destructive: true,
    },
    async ({ eventId, id }, context) => {
      const detail = await eventDetail(eventId);
      const booking = await cancelRoomBooking(mcpActor(context), id, eventId);
      await emitChange({ entityType: "eventRoomBooking", id: booking.id, op: "updated" });
      await emitChange({ entityType: "event", id: eventId, op: "updated" });
      return { ...booking, label: detail.event.title };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "add_equipment_allocation",
      description:
        "Allocate pooled equipment to an event. The database rejects overlapping allocations.",
      schema: z.object({ eventId: id, input: allocationInput }),
      write: true,
    },
    async ({ eventId, input }, context) => {
      const detail = await eventDetail(eventId);
      const allocation = await withBookingConflict("equipment", input.equipmentId, input, () =>
        addAllocation(mcpActor(context), eventId, allocationSchema.parse(eventTimes(input))),
      );
      await emitChange({ entityType: "equipmentAllocation", id: allocation.id, op: "created" });
      await emitChange({ entityType: "event", id: eventId, op: "updated" });
      return { ...allocation, label: detail.event.title };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "cancel_equipment_allocation",
      description: "Cancel an equipment allocation belonging to this event. Requires confirm:true.",
      schema: z.object({ eventId: id, id, confirm }),
      write: true,
      destructive: true,
    },
    async ({ eventId, id }, context) => {
      const detail = await eventDetail(eventId);
      const allocation = await cancelAllocation(mcpActor(context), id, eventId);
      await emitChange({ entityType: "equipmentAllocation", id: allocation.id, op: "updated" });
      await emitChange({ entityType: "event", id: eventId, op: "updated" });
      return { ...allocation, label: detail.event.title };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "add_service_window",
      description: "Add a setup, standby or teardown service window to an event.",
      schema: z.object({ eventId: id, input: windowInput }),
      write: true,
    },
    async ({ eventId, input }, context) => {
      const detail = await eventDetail(eventId);
      const window = await addServiceWindow(
        mcpActor(context),
        eventId,
        serviceWindowSchema.parse(eventTimes(input)),
      );
      await emitChange({ entityType: "serviceWindow", id: window.id, op: "created" });
      await emitChange({ entityType: "event", id: eventId, op: "updated" });
      return { ...window, label: detail.event.title };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "remove_service_window",
      description: "Remove a service window belonging to this event. Requires confirm:true.",
      schema: z.object({ eventId: id, id, confirm }),
      write: true,
      destructive: true,
    },
    async ({ eventId, id }, context) => {
      const detail = await eventDetail(eventId);
      await removeServiceWindow(mcpActor(context), id, eventId);
      await emitChange({ entityType: "serviceWindow", id, op: "deleted" });
      await emitChange({ entityType: "event", id: eventId, op: "updated" });
      return { id, eventId, label: detail.event.title, removed: true };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "create_ticket",
      description:
        "Create a ticket, including a born-resolved repair with a resolution. Dates must be ISO instants. Result includes legal next actions; inspect get_allowed_actions before later transitions.",
      schema: z.object({
        input: z
          .object({ ...ticketCreateSchema.shape, ...ticketDates })
          .refine((input) => input.status !== "CANCELLED", {
            path: ["status"],
            message: msgKey("err.mcp.useTransitionTicket"),
          }),
      }),
      write: true,
    },
    async ({ input }, context) => {
      const ticket = await createTicket(mcpActor(context), ticketCreateSchema.parse(input));
      await emitChange({ entityType: "ticket", id: ticket.id, op: "created" });
      return { ...ticket, label: ticket.title, ...ticketActionMetadata(ticket.status) };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "update_ticket",
      description:
        "Replace ticket content and assignees without changing its status. Dates must be ISO instants. Result includes legal next actions; see get_allowed_actions.",
      schema: z.object({
        id,
        input: ticketEditSchema
          .omit({ occurredAt: true })
          .extend({ occurredAt: instant.optional() }),
      }),
      write: true,
    },
    async ({ id, input }, context) => {
      const ticket = await updateTicket(mcpActor(context), id, ticketEditSchema.parse(input));
      await emitChange({ entityType: "ticket", id: ticket.id, op: "updated" });
      return { ...ticket, label: ticket.title, ...ticketActionMetadata(ticket.status) };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "transition_ticket",
      description:
        "Change ticket status: OPEN → IN_PROGRESS/RESOLVED/CANCELLED; IN_PROGRESS → OPEN/RESOLVED/CANCELLED; RESOLVED or CANCELLED → OPEN/IN_PROGRESS. No self transitions. RESOLVED requires nonblank resolution. Refresh get_allowed_actions first; confirm:true is required.",
      schema: z.object({ id, input: ticketTransitionSchema, confirm }),
      write: true,
      destructive: true,
    },
    async ({ id, input }, context) => {
      const ticket = await transitionTicket(mcpActor(context), id, input);
      await emitChange({ entityType: "ticket", id: ticket.id, op: "updated" });
      return { ...ticket, label: ticket.title, ...ticketActionMetadata(ticket.status) };
    },
  );
  registerTool(
    server,
    ctx,
    {
      name: "move_ticket",
      description:
        "Move a ticket through the same workflow as transition_ticket: OPEN → IN_PROGRESS/RESOLVED/CANCELLED; IN_PROGRESS → OPEN/RESOLVED/CANCELLED; closed → OPEN/IN_PROGRESS. BACKLOG maps OPEN, DONE maps RESOLVED. DONE requires nonblank resolution; IN_REVIEW is invalid. Same-lane moves are unaudited no-ops. Refresh get_allowed_actions first. Requires confirm:true.",
      schema: z.object({
        id,
        lane: z.enum(LANES),
        resolution: ticketTransitionSchema.shape.resolution,
        confirm,
      }),
      write: true,
      destructive: true,
    },
    async ({ id, lane, resolution }, context) => {
      const ticket = await moveTicketToLane(mcpActor(context), id, lane, { resolution });
      await emitChange({ entityType: "ticket", id: ticket.id, op: "updated" });
      return { ...ticket, label: ticket.title, lane, ...ticketActionMetadata(ticket.status) };
    },
  );
}
