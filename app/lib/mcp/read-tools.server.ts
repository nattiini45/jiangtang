import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { msgKey } from "~/i18n";
import { tr } from "~/i18n/request-locale.server";
import { withMcpEquipmentKind } from "./tools.server";
import { listDeviceKinds } from "~/lib/equipment-kinds/kinds.server";
import {
  EquipmentCategory,
  EquipmentMobility,
  EquipmentStatus,
  EventStatus,
  LocationKind,
  RoomStatus,
  TicketStatus,
  TicketType,
} from "~/generated/prisma/enums";
import {
  listCampuses,
  getCampus,
  listBuildings,
  getBuilding,
  listRooms,
  getRoom,
} from "~/domains/rooms/rooms.queries.server";
import { getLocation, listLocations } from "~/domains/locations/locations.queries.server";
import { listModels, getModel } from "~/domains/catalog/catalog.queries.server";
import { listEquipment, getEquipment } from "~/domains/inventory/inventory.queries.server";
import {
  listStock,
  getStockItemWithRefs,
} from "~/domains/inventory/inventory.stock.queries.server";
import { stockListOptionsSchema } from "~/domains/inventory/inventory.stock.schema";
import { listEvents, getEventDetail } from "~/domains/events/events.queries.server";
import {
  findRoomConflicts,
  findEquipmentConflicts,
} from "~/domains/events/events.availability.server";
import { findFreeSlot } from "~/domains/events/events.free-slot.queries.server";
import {
  listRoomBookings,
  getRoomBooking,
  listEquipmentAllocations,
  getEquipmentAllocation,
} from "~/domains/events/events.bookings.queries.server";
import {
  listTickets,
  getTicket,
  listAssignableUsers,
} from "~/domains/tickets/tickets.queries.server";
import { listTasks, getTask, listBoardTasks } from "~/domains/tasks/tasks.queries.server";
import { taskListOptionsSchema } from "~/domains/tasks/tasks.schema";
import { LANES } from "~/domains/tasks/tasks.lanes";
import {
  listProjects,
  getProjectBySlug,
  getProject,
} from "~/domains/projects/projects.queries.server";
import { projectListOptionsSchema } from "~/domains/projects/projects.schema";
import { listWorkTickets } from "~/domains/board/board.queries.server";
import { listNotes, getNote, listNoteTags } from "~/domains/notes/notes.queries.server";
import { noteListOptionsSchema } from "~/domains/notes/notes.schema";
import {
  listWeekEntries,
  getWeekTimesheet,
  getRunningEntry,
  getTimeEntry,
} from "~/domains/time/time.queries.server";
import { listVendorDetails, getVendorDetail } from "~/domains/vendors/vendors.queries.server";
import {
  listAttachments,
  getAttachmentMetadata,
} from "~/domains/attachments/attachments.queries.server";
import { listActivity } from "~/domains/activity/activity.queries.server";
import {
  listNotifications,
  getNotification,
  unreadNotificationCount,
} from "~/domains/notifications/notifications.queries.server";
import { searchWorkspace } from "~/domains/search/search.queries.server";
import { SOURCE_TYPES } from "~/lib/search/source-types";
import { isoWeekRange, dayIndexToIsoWeek } from "~/lib/berlin-days";
import { NotFoundError } from "~/lib/errors.server";
import { registerTool } from "~/lib/mcp/tools.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { withCustomValues } from "~/lib/custom-fields/values.server";
import { listRoomFunctions, getFunctionStates } from "~/domains/functions/functions.queries.server";

const id = z.string().trim().min(1).max(200);
const byId = z.object({ id });
const q = z.string().trim().min(1).max(500).optional();
const pagination = z.object({
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
const instant = z.iso.datetime({ offset: true });
const bookingList = pagination.extend({
  eventId: id.optional(),
  from: instant.optional(),
  to: instant.optional(),
  cancelled: z.boolean().default(false),
});
const isoWeek = z
  .string()
  .regex(/^\d{4}-W\d{2}$/)
  .refine((value) => {
    try {
      return dayIndexToIsoWeek(isoWeekRange(value).startDay) === value;
    } catch {
      return false;
    }
  });
const timeOwner = z.object({ userId: id.optional() });
const activityTypes = [
  "customField",
  "timeEntry",
  "user",
  "campus",
  "building",
  "room",
  "equipmentModel",
  "equipment",
  "ticket",
  "event",
  "eventRoomBooking",
  "equipmentAllocation",
  "serviceWindow",
  "attachment",
  "location",
  "inventory-item",
  "project",
  "task",
  "note",
  "vendor",
] as const;

function queryPage(input: { offset: number; limit: number }) {
  return { offset: input.offset, limit: input.limit + 1 };
}

function page<T>(items: T[], input: { offset: number; limit: number }) {
  return {
    items: items.slice(0, input.limit),
    nextOffset: items.length > input.limit ? input.offset + input.limit : null,
  };
}

async function found<T>(result: Promise<T | null>) {
  const value = await result;
  if (value === null) throw new NotFoundError();
  return value;
}

function timeUser(userId: string | undefined, context: McpContext) {
  return userId ?? context.user.id;
}

export function registerReadTools(server: McpServer, context: McpContext): void {
  registerTool(
    server,
    context,
    {
      name: "list_room_functions",
      description:
        "List installed room functions and the device kinds that carry them or lie on their signal path.",
      schema: z.object({}),
    },
    async () => listRoomFunctions(),
  );
  registerTool(
    server,
    context,
    {
      name: "get_room_functions",
      description:
        "Read a room's derived function states, evidence and devices. No known fault is unconfirmed, never works.",
      schema: z.object({ roomId: id }),
    },
    async ({ roomId }) => {
      if (!(await getRoom(roomId))) throw new NotFoundError(tr("err.room.notFound"));
      return getFunctionStates({ roomIds: [roomId] });
    },
  );
  registerTool(
    server,
    context,
    {
      name: "list_room_bookings",
      description:
        "List room bookings with room/event IDs and labels, independently of parent event times/status. Defaults to active bookings; cancelled=true lists cancelled rows instead. Optional ISO-instant window uses half-open overlap. Follow nextOffset.",
      schema: bookingList
        .extend({ roomId: id.optional() })
        .refine((input) => !input.from || !input.to || new Date(input.from) < new Date(input.to), {
          path: ["to"],
          message: msgKey("err.mcp.toAfterFrom"),
        }),
    },
    async (input) =>
      page(
        await listRoomBookings({
          ...input,
          from: input.from ? new Date(input.from) : undefined,
          to: input.to ? new Date(input.to) : undefined,
          ...queryPage(input),
        }),
        input,
      ),
  );
  registerTool(
    server,
    context,
    {
      name: "get_room_booking",
      description:
        "Get a room booking, including cancellation state, room and event labels, by booking ID.",
      schema: byId,
    },
    ({ id }) => found(getRoomBooking(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_equipment_allocations",
      description:
        "List equipment allocations with equipment/event IDs and labels, independently of parent event times/status. Defaults to active allocations; cancelled=true lists cancelled rows instead. Optional ISO-instant window uses half-open overlap. Follow nextOffset.",
      schema: bookingList
        .extend({ equipmentId: id.optional() })
        .refine((input) => !input.from || !input.to || new Date(input.from) < new Date(input.to), {
          path: ["to"],
          message: msgKey("err.mcp.toAfterFrom"),
        }),
    },
    async (input) =>
      page(
        await listEquipmentAllocations({
          ...input,
          from: input.from ? new Date(input.from) : undefined,
          to: input.to ? new Date(input.to) : undefined,
          ...queryPage(input),
        }),
        input,
      ),
  );
  registerTool(
    server,
    context,
    {
      name: "get_equipment_allocation",
      description:
        "Get an equipment allocation, including cancellation state, equipment and event labels, by allocation ID.",
      schema: byId,
    },
    ({ id }) => found(getEquipmentAllocation(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_campuses",
      description:
        "List campuses with IDs, names and their buildings. Follow nextOffset for further pages.",
      schema: pagination,
    },
    async (input) => page(await listCampuses(queryPage(input)), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_campus",
      description: "Get a campus by ID.",
      schema: byId,
    },
    ({ id }) => found(getCampus(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_buildings",
      description:
        "List buildings, optionally within a campus, with campus IDs and names. Follow nextOffset.",
      schema: pagination.extend({ campusId: id.optional() }),
    },
    async (input) => page(await listBuildings(input.campusId, queryPage(input)), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_building",
      description: "Get a building and its campus by building ID.",
      schema: byId,
    },
    ({ id }) => found(getBuilding(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_rooms",
      description:
        "List bookable rooms with campus/building labels, status, capacity, knownIssues and lastCheckedAt. Rooms are separate from storage locations. Follow nextOffset.",
      schema: pagination.extend({
        campusId: id.optional(),
        status: z.enum(RoomStatus).optional(),
        q,
      }),
    },
    async (input) =>
      page(
        (await withCustomValues("ROOM", await listRooms(input, queryPage(input)))).map(
          withRoomBookingAction,
        ),
        input,
      ),
  );
  registerTool(
    server,
    context,
    {
      name: "get_room",
      description: "Get a bookable room by ID, including its capabilities, campus and building.",
      schema: byId,
    },
    async ({ id }) =>
      withRoomBookingAction((await withCustomValues("ROOM", [await found(getRoom(id))], true))[0]),
  );
  registerTool(
    server,
    context,
    {
      name: "list_locations",
      description:
        "List locations with parent IDs and names. Omit parentId for all nodes; null lists roots, an ID lists direct children. These are not bookable rooms. Follow nextOffset.",
      schema: pagination.extend({
        parentId: id.nullable().optional(),
        kind: z.enum(LocationKind).optional(),
        q,
      }),
    },
    async (input) => page(await listLocations({ ...input, ...queryPage(input) }), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_location",
      description: "Get a storage/work location by ID, including its parent ID.",
      schema: byId,
    },
    ({ id }) => found(getLocation(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_equipment_models",
      description:
        "List equipment catalog models and instance/fault counts. Follow nextOffset; use list_equipment with modelId for instances.",
      schema: pagination.extend({
        kindId: id.optional(),
        category: z.enum(EquipmentCategory).optional(),
        q,
      }),
    },
    async (input) =>
      page((await listModels(input, queryPage(input))).map(withMcpEquipmentKind), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_equipment_model",
      description:
        "Get an equipment catalog model by ID. Use list_equipment with modelId for its instances.",
      schema: byId,
    },
    async ({ id }) => withMcpEquipmentKind(await found(getModel(id))),
  );
  registerTool(
    server,
    context,
    {
      name: "list_device_kinds",
      description:
        "List function groups in display order with their device kinds. Names are installation data. Use a kind ID in device/model writes and filters. Active groups and kinds only by default.",
      schema: z.object({ includeArchived: z.boolean().default(false) }),
    },
    async ({ includeArchived }) =>
      (await listDeviceKinds(includeArchived)).map((group) => ({
        ...group,
        kinds: group.kinds.map(({ systemKey, _count, ...kind }) => ({
          ...kind,
          key: systemKey,
          groupId: group.id,
          deviceCount: _count?.equipment ?? 0,
          modelCount: _count?.models ?? 0,
        })),
      })),
  );
  registerTool(
    server,
    context,
    {
      name: "list_equipment",
      description:
        "List equipment instances with room/model names, kind and function group, asset tags, mobility and status. Filter by kindId; category is a deprecated compatibility alias, ignored when kindId is given. Follow nextOffset.",
      schema: pagination.extend({
        roomId: id.optional(),
        modelId: id.optional(),
        kindId: id.optional(),
        category: z.enum(EquipmentCategory).optional(),
        status: z.enum(EquipmentStatus).optional(),
        mobility: z.enum(EquipmentMobility).optional(),
        q,
      }),
    },
    async (input) =>
      page(
        (await withCustomValues("EQUIPMENT", await listEquipment(input, queryPage(input))))
          .map(withMcpEquipmentKind)
          .map(withEquipmentAllocationAction),
        input,
      ),
  );
  registerTool(
    server,
    context,
    {
      name: "get_equipment",
      description:
        "Get an equipment instance, model, room, ordered ports, both-ended connections and port action legality, plus spare/substitute links by ID. Write permission still requires a write token.",
      schema: byId,
    },
    async ({ id }) =>
      withEquipmentAllocationAction(
        withMcpEquipmentKind(
          (await withCustomValues("EQUIPMENT", [await found(getEquipment(id))], true))[0],
        ),
      ),
  );
  registerTool(
    server,
    context,
    {
      name: "list_stock",
      description:
        "List inventory stock with vendor/location/equipment IDs and labels. includeUnassigned defaults true, including unplaced stock alongside a location filter. Follow nextOffset.",
      schema: stockListOptionsSchema.extend(pagination.shape),
    },
    async (input) => page(await listStock(input, queryPage(input)), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_stock_item",
      description: "Get an inventory stock item with linked vendor, location and equipment by ID.",
      schema: byId,
    },
    ({ id }) => found(getStockItemWithRefs(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_events",
      description:
        "List events by status, text or optional overlapping ISO-instant window [from,to). Follow nextOffset.",
      schema: pagination
        .extend({
          status: z.enum(EventStatus).optional(),
          q,
          from: instant.optional(),
          to: instant.optional(),
        })
        .refine((input) => !input.from || !input.to || new Date(input.from) < new Date(input.to), {
          path: ["to"],
          message: msgKey("err.mcp.toAfterFrom"),
        }),
    },
    async (input) =>
      page(
        await listEvents(
          {
            ...input,
            from: input.from ? new Date(input.from) : undefined,
            to: input.to ? new Date(input.to) : undefined,
          },
          queryPage(input),
        ),
        input,
      ),
  );
  registerTool(
    server,
    context,
    {
      name: "get_event",
      description:
        "Get an event and all active room bookings, equipment allocations, service windows and linked tickets by event ID. calendarSync.configured reports whether CalDAV is configured; latest is retained publication history, not a promise of pending work when configured is false.",
      schema: byId,
    },
    ({ id }) => found(getEventDetail(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "check_booking_conflicts",
      description:
        "Check active room bookings or equipment allocations overlapping [startsAt,endsAt), using ISO instants with offsets. Adjacent intervals do not conflict. excludeId is the booking ID (room) or allocation ID (equipment) being edited, never an event ID. This does not reserve anything; the database is authoritative at save.",
      schema: z
        .object({
          kind: z.enum(["room", "equipment"]),
          id,
          startsAt: instant,
          endsAt: instant,
          excludeId: id.optional(),
        })
        .refine((input) => new Date(input.endsAt) > new Date(input.startsAt), {
          path: ["endsAt"],
          message: msgKey("err.mcp.endsAfterStarts"),
        }),
    },
    async (input) => {
      const resource =
        input.kind === "room"
          ? await found(getRoom(input.id))
          : await found(getEquipment(input.id));
      const conflicts =
        input.kind === "room"
          ? await findRoomConflicts(
              input.id,
              new Date(input.startsAt),
              new Date(input.endsAt),
              input.excludeId,
            )
          : await findEquipmentConflicts(
              input.id,
              new Date(input.startsAt),
              new Date(input.endsAt),
              input.excludeId,
            );
      return { resource: { id: resource.id, name: resource.name }, conflicts };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "find_free_slot",
      description:
        "Find the earliest common booking-free interval for the selected rooms/equipment within an ISO-instant window of at most 31 days. Returns null if none fits. Resource status is returned, not filtered; this checks occupancy only, not suitability or working hours, and never reserves a slot.",
      schema: z
        .object({
          roomIds: z.array(id).max(20).default([]),
          equipmentIds: z.array(id).max(20).default([]),
          from: instant,
          to: instant,
          durationMinutes: z.number().int().min(1).max(10_080),
        })
        .refine((input) => input.roomIds.length + input.equipmentIds.length > 0, {
          message: msgKey("err.mcp.resourceRequired"),
        })
        .refine(
          (input) => {
            const window = new Date(input.to).getTime() - new Date(input.from).getTime();
            return (
              window > 0 && window <= 31 * 86_400_000 && input.durationMinutes * 60_000 <= window
            );
          },
          { path: ["to"], message: msgKey("err.mcp.slotWindow") },
        ),
    },
    (input) => findFreeSlot({ ...input, from: new Date(input.from), to: new Date(input.to) }),
  );
  registerTool(
    server,
    context,
    {
      name: "list_tickets",
      description:
        "List incident, request or repair tickets with room/equipment labels and assignees. Follow nextOffset.",
      schema: pagination.extend({
        type: z.enum(TicketType).optional(),
        status: z.enum(TicketStatus).optional(),
        roomId: id.optional(),
        equipmentId: id.optional(),
        q,
      }),
    },
    async (input) => page(await listTickets(input, queryPage(input)), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_ticket",
      description:
        "Get a ticket with its reporter, assignees, room, equipment, event, linked tasks and legal next actions by ID. Use get_allowed_actions to inspect write permission and required inputs before acting.",
      schema: byId,
    },
    ({ id }) => found(getTicket(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "get_allowed_actions",
      description:
        "Inspect a ticket, task or project by ID for current state, legal next actions, required inputs and caller write permission. Tickets: OPEN → IN_PROGRESS/RESOLVED/CANCELLED; IN_PROGRESS → OPEN/RESOLVED/CANCELLED; RESOLVED or CANCELLED → OPEN/IN_PROGRESS. Tasks and projects allow every distinct status pair, without dependency or hierarchy completion gates. No self status transitions; task same-lane reorder remains legal. READ_ONLY may inspect but cannot write. Refresh before acting. Ticket transition/move requires confirm:true; task/project status and task move retain their existing confirmation-free inputs.",
      schema: z.object({ entityType: z.enum(["ticket", "task", "project"]), id }),
    },
    async ({ entityType, id }, context) => {
      const entity =
        entityType === "ticket"
          ? await found(getTicket(id))
          : entityType === "task"
            ? await found(getTask(id))
            : await found(getProject(id));
      const canWrite = context.token.scope === "READ_WRITE";
      return {
        entity: entityType,
        id,
        currentState: entity.status,
        allowedTransitions: entity.allowedTransitions,
        allowedActions: entity.allowedActions,
        canWrite,
        permissionReason: canWrite
          ? null
          : { code: "READ_ONLY", message: tr("err.mcp.writeTokenRequired") },
        requiresConfirmation: entityType === "ticket",
      };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "list_assignment_principals",
      description:
        "List active assignment targets with ID, name and initials only. No account settings or sensitive user fields. Follow nextOffset.",
      schema: pagination,
    },
    async (input) => page(await listAssignableUsers(queryPage(input)), input),
  );
  registerTool(
    server,
    context,
    {
      name: "list_tasks",
      description:
        "List tasks by project, status, assignee, label, text or due window, with parent/assignee labels and blocked state. Follow nextOffset.",
      schema: taskListOptionsSchema
        .extend({ ...pagination.shape, dueFrom: instant.optional(), dueTo: instant.optional() })
        .refine(
          (input) =>
            !input.dueFrom || !input.dueTo || new Date(input.dueFrom) <= new Date(input.dueTo),
          { path: ["dueTo"], message: msgKey("err.mcp.dueWindow") },
        ),
    },
    async (input) =>
      page(
        await listTasks(
          {
            ...input,
            dueFrom: input.dueFrom ? new Date(input.dueFrom) : undefined,
            dueTo: input.dueTo ? new Date(input.dueTo) : undefined,
          },
          queryPage(input),
        ),
        input,
      ),
  );
  registerTool(
    server,
    context,
    {
      name: "get_task",
      description:
        "Get a task with subtasks, parent, dependencies in both directions, assignee IDs/estimates, project, location, linked tickets and legal next status actions. Explicit BLOCKED and dependency-derived blocking are independent.",
      schema: byId,
    },
    ({ id }) => found(getTask(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_projects",
      description:
        "List projects with lead IDs/labels and open/done task counts. Follow nextOffset.",
      schema: projectListOptionsSchema.extend(pagination.shape),
    },
    async (input) => page(await listProjects(input, queryPage(input)), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_project",
      description:
        "Get a project by its URL slug, including parent, subprojects, lead, task/dependency summaries and legal next status actions. get_allowed_actions takes the project ID, not its slug.",
      schema: z.object({ slug: id }),
    },
    ({ slug }) => found(getProjectBySlug(slug)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_board",
      description:
        "List task or ticket cards within one required board lane, optionally scoped to a project/assignee. Follow nextOffset. Filtering and stable ordering happen in the database before pagination.",
      schema: pagination.extend({
        kind: z.enum(["task", "ticket"]),
        projectId: id.optional(),
        assigneeId: id.optional(),
        lane: z.enum(LANES),
      }),
    },
    async (input) => {
      const bounds = { lane: input.lane, ...queryPage(input) };
      return input.kind === "task"
        ? page(await listBoardTasks(input, bounds), input)
        : page(await listWorkTickets(input, bounds), input);
    },
  );
  registerTool(
    server,
    context,
    {
      name: "list_notes",
      description:
        "List workspace-shared notes with author/project/location labels; pinned notes first. Archived notes are excluded by default. Follow nextOffset.",
      schema: noteListOptionsSchema.extend(pagination.shape),
    },
    async (input) => page(await listNotes(input, queryPage(input)), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_note",
      description:
        "Get a workspace-shared note, its Markdown body, version, author and project/location links by ID. Notes have no private visibility mode.",
      schema: byId,
    },
    ({ id }) => found(getNote(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_note_tags",
      description: "List note tags with counts, including archived notes. Follow nextOffset.",
      schema: pagination,
    },
    async (input) => page(await listNoteTags(queryPage(input)), input),
  );
  registerTool(
    server,
    context,
    {
      name: "list_time_entries",
      description:
        "List entries overlapping an ISO week (YYYY-Www, Europe/Berlin). Defaults to your own entries; another userId requires time.viewOthers. Follow nextOffset.",
      schema: timeOwner.extend({ ...pagination.shape, isoWeek }),
    },
    async (input, ctx) =>
      page(
        await listWeekEntries(
          ctx.user,
          timeUser(input.userId, ctx),
          input.isoWeek,
          queryPage(input),
        ),
        input,
      ),
  );
  registerTool(
    server,
    context,
    {
      name: "get_time_entry",
      description:
        "Get your time entry with its task label. Another userId requires time.viewOthers; missing or unowned entries return not found.",
      schema: timeOwner.extend({ id }),
    },
    (input, ctx) => found(getTimeEntry(ctx.user, input.id, timeUser(input.userId, ctx))),
  );
  registerTool(
    server,
    context,
    {
      name: "get_timesheet",
      description:
        "Get per-task/day totals for an ISO week in Europe/Berlin, with overlapping intervals counted once in daily/weekly totals. Defaults to your own timesheet; another userId requires time.viewOthers. Use list_time_entries for paginated source entries.",
      schema: timeOwner.extend({ isoWeek }),
    },
    async (input, ctx) => {
      const { entries: _entries, ...sheet } = await getWeekTimesheet(
        ctx.user,
        timeUser(input.userId, ctx),
        input.isoWeek,
      );
      return sheet;
    },
  );
  registerTool(
    server,
    context,
    {
      name: "get_running_timer",
      description: "Get your running timer, or null. Another userId requires time.viewOthers.",
      schema: timeOwner,
    },
    (input, ctx) => getRunningEntry(ctx.user, timeUser(input.userId, ctx)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_vendors",
      description: "List vendors and their contact/location details. Follow nextOffset.",
      schema: pagination.extend({ q }),
    },
    async (input) => page(await listVendorDetails({ ...input, ...queryPage(input) }), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_vendor",
      description: "Get a vendor with contact and location details by ID.",
      schema: byId,
    },
    ({ id }) => found(getVendorDetail(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_attachments",
      description:
        "List attachment metadata for exactly one room, equipment instance or ticket. Returns object keys, not file bytes or public download links. Follow nextOffset.",
      schema: pagination
        .extend({ roomId: id.optional(), equipmentId: id.optional(), ticketId: id.optional() })
        .refine(
          (input) => [input.roomId, input.equipmentId, input.ticketId].filter(Boolean).length === 1,
          { message: msgKey("err.mcp.attachmentTarget") },
        ),
    },
    async (input) => page(await listAttachments(input, queryPage(input)), input),
  );
  registerTool(
    server,
    context,
    {
      name: "get_attachment",
      description:
        "Get attachment metadata and parent IDs/labels by attachment ID. Does not return file bytes or storage paths.",
      schema: byId,
    },
    ({ id }) => found(getAttachmentMetadata(id)),
  );
  registerTool(
    server,
    context,
    {
      name: "list_activity",
      description:
        "Requires audit.view. List workspace activity with resolved entity titles and actor display labels, using nextCursor pagination. Time-entry rows require ownership or time.viewOthers; grant, revoke and view accountability remains visible. Notifications, actor emails and raw audit data are omitted.",
      schema: z.object({
        actorId: id.optional(),
        entityTypes: z.array(z.enum(activityTypes)).min(1).max(activityTypes.length).optional(),
        cursor: z.string().max(2000).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    },
    async (input, ctx) => {
      const result = await listActivity(ctx.user, {
        ...input,
        entityTypes: input.entityTypes ?? [...activityTypes],
        userAccountabilityOnly: true,
      });
      return {
        ...result,
        items: result.items.map(({ actorSnapshot, ...item }) => {
          const actor =
            actorSnapshot && typeof actorSnapshot === "object" && !Array.isArray(actorSnapshot)
              ? actorSnapshot
              : {};
          return {
            ...item,
            actor: {
              name: typeof actor.name === "string" ? actor.name : null,
              initials: typeof actor.initials === "string" ? actor.initials : null,
              via: typeof actor.via === "string" ? actor.via : null,
              tokenId: typeof actor.tokenId === "string" ? actor.tokenId : null,
            },
          };
        }),
      };
    },
  );
  registerTool(
    server,
    context,
    {
      name: "list_notifications",
      description:
        "List only your notifications, optionally unread-only, plus your unread count. Follow nextOffset.",
      schema: pagination.extend({ unreadOnly: z.boolean().default(false) }),
    },
    async (input, ctx) => ({
      ...page(await listNotifications(ctx.user.id, { ...input, ...queryPage(input) }), input),
      unreadCount: await unreadNotificationCount(ctx.user.id),
    }),
  );
  registerTool(
    server,
    context,
    {
      name: "get_notification",
      description:
        "Get one of your notifications by ID. Missing or unowned notifications return not found.",
      schema: byId,
    },
    ({ id }, ctx) => found(getNotification(ctx.user.id, id)),
  );
  registerTool(
    server,
    context,
    {
      name: "search_workspace",
      description:
        "Search workspace text with lexical/fuzzy recall and semantic recall when configured. Returns ranked source IDs, titles, snippets and degradation status. This is a ranked top-N search, not an exhaustive list; the retrieval candidate pool is capped at 50. Use domain list tools for complete pagination.",
      schema: z.object({
        q: z.string().trim().min(1).max(500),
        sourceTypes: z.array(z.enum(SOURCE_TYPES)).min(1).max(SOURCE_TYPES.length).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    },
    (input) => searchWorkspace(input.q, { limit: input.limit, sourceTypes: input.sourceTypes }),
  );
}
import {
  withRoomBookingAction,
  withEquipmentAllocationAction,
} from "~/domains/events/events.health-policy";
