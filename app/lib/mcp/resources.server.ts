import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/server";
import { tr } from "~/i18n/request-locale.server";
import { getRoom, listRooms } from "~/domains/rooms/rooms.queries.server";
import { getEquipment, listEquipment } from "~/domains/inventory/inventory.queries.server";
import { getEventDetail, listEvents } from "~/domains/events/events.queries.server";
import { getTicket, listTickets } from "~/domains/tickets/tickets.queries.server";
import { getProjectBySlug, listProjects } from "~/domains/projects/projects.queries.server";
import { getTask, listTasks } from "~/domains/tasks/tasks.queries.server";
import { getNote, listNotes } from "~/domains/notes/notes.queries.server";
import { getTimeEntry } from "~/domains/time/time.queries.server";
import { serializeMcp, withMcpEquipmentKind } from "~/lib/mcp/tools.server";
import { logger } from "~/lib/observability/logger.server";
import type { McpContext } from "~/lib/mcp/types.server";

async function readResource(uri: URL, query: () => Promise<unknown>) {
  try {
    const result = await query();
    if (result === null) throw new ResourceNotFoundError(uri.href, tr("err.notFound"));
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ result: serializeMcp(result), timeZone: "Europe/Berlin" }),
        },
      ],
    };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    const correlationId = crypto.randomUUID();
    logger.error({ correlationId, resource: uri.hostname }, "MCP resource read failed");
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      tr("err.internalRef", { ref: correlationId }),
    );
  }
}

export function registerResources(server: McpServer, context: McpContext): void {
  server.registerResource(
    "workspace_context",
    "jiangtang://workspace/context",
    {
      description: "Safe connection context and workspace reading rules",
      mimeType: "application/json",
    },
    (uri) =>
      readResource(uri, async () => ({
        tokenScope: context.token.scope,
        timeZone: "Europe/Berlin",
        guidance: tr("mcp.resources.guidance"),
      })),
  );

  const collections: Array<{
    name: string;
    query: () => Promise<unknown[]>;
    tool: string;
  }> = [
    {
      name: "rooms",
      query: async () => (await listRooms({}, { limit: 51 })).map(withRoomBookingAction),
      tool: "list_rooms",
    },
    {
      name: "equipment",
      query: async () =>
        (await listEquipment({}, { limit: 51 }))
          .map(withMcpEquipmentKind)
          .map(withEquipmentAllocationAction),
      tool: "list_equipment",
    },
    { name: "events", query: () => listEvents({}, { limit: 51 }), tool: "list_events" },
    { name: "tickets", query: () => listTickets({}, { limit: 51 }), tool: "list_tickets" },
    { name: "projects", query: () => listProjects({}, { limit: 51 }), tool: "list_projects" },
    { name: "tasks", query: () => listTasks({}, { limit: 51 }), tool: "list_tasks" },
    { name: "notes", query: () => listNotes({}, { limit: 51 }), tool: "list_notes" },
  ];
  for (const collection of collections) {
    server.registerResource(
      `${collection.name}_collection`,
      `jiangtang://collections/${collection.name}`,
      {
        description: `First 50 ${collection.name} in normal list order. Continue with ${collection.tool} and nextOffset; use that tool for filters.`,
        mimeType: "application/json",
      },
      (uri) =>
        readResource(uri, async () => {
          const items = await collection.query();
          return {
            items: items.slice(0, 50),
            nextOffset: items.length > 50 ? 50 : null,
            continuationTool: collection.tool,
          };
        }),
    );
  }

  const details: Array<{
    name: string;
    variable: string;
    description: string;
    query: (id: string) => Promise<unknown>;
  }> = [
    {
      name: "rooms",
      variable: "id",
      description: "Room capabilities, status and building",
      query: async (id) => {
        const room = await getRoom(id);
        return room ? withRoomBookingAction(room) : null;
      },
    },
    {
      name: "equipment",
      variable: "id",
      description: "Equipment model, room and substitution links",
      query: async (id) => {
        const equipment = await getEquipment(id);
        return equipment ? withEquipmentAllocationAction(withMcpEquipmentKind(equipment)) : null;
      },
    },
    {
      name: "events",
      variable: "id",
      description: "Event with active bookings, allocations, service windows and tickets",
      query: getEventDetail,
    },
    {
      name: "tickets",
      variable: "id",
      description: "Ticket with assignments and linked work",
      query: getTicket,
    },
    {
      name: "projects",
      variable: "slug",
      description:
        "Project by slug with hierarchy, tasks, dependencies and legal next status actions",
      query: getProjectBySlug,
    },
    {
      name: "tasks",
      variable: "id",
      description:
        "Task with assignments, dependencies, linked work and legal next status actions; no time entries",
      query: getTask,
    },
    {
      name: "notes",
      variable: "id",
      description: "Shared workspace note, including archived notes",
      query: getNote,
    },
    {
      name: "my-time-entries",
      variable: "id",
      description:
        "Connecting user's own time entry and private comment only, including for admins",
      query: (id) => getTimeEntry(context.user, id),
    },
  ];
  for (const detail of details) {
    server.registerResource(
      `${detail.name}_detail`,
      new ResourceTemplate(`jiangtang://${detail.name}/{${detail.variable}}`, { list: undefined }),
      { description: detail.description, mimeType: "application/json" },
      (uri, variables) =>
        readResource(uri, async () => {
          const id = variables[detail.variable];
          if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, tr("mcp.resources.invalidId"));
          }
          return detail.query(id);
        }),
    );
  }
}
import {
  withRoomBookingAction,
  withEquipmentAllocationAction,
} from "~/domains/events/events.health-policy";
