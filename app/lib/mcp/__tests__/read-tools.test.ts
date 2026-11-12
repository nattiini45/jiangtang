import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerReadTools } from "~/lib/mcp/read-tools.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { searchWorkspace } from "~/domains/search/search.queries.server";

const { db } = vi.hoisted(() => {
  const model = () => ({
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
  });
  return {
    db: {
      campus: model(),
      building: model(),
      room: model(),
      location: model(),
      equipmentModel: model(),
      equipmentFunctionGroup: model(),
      equipment: model(),
      inventoryItem: model(),
      event: model(),
      calendarOutbox: model(),
      eventRoomBooking: model(),
      equipmentAllocation: model(),
      ticket: model(),
      task: model(),
      project: model(),
      note: model(),
      timeEntry: model(),
      vendor: model(),
      attachment: model(),
      activityLog: model(),
      notification: model(),
      user: model(),
      $queryRaw: vi.fn(),
    },
  };
});
vi.mock("~/lib/db.server", () => ({ db }));
vi.mock("~/domains/search/search.queries.server", () => ({ searchWorkspace: vi.fn() }));

const member: McpContext = {
  user: {
    id: "member",
    name: "Member",
    email: "member@example.invalid",
    initials: "MB",
    role: "MEMBER",
  },
  token: { id: "read-token", name: "Read-only", scope: "READ_ONLY" },
};
type Registered = {
  config: { annotations: Record<string, unknown> };
  handler: (input: unknown) => Promise<CallToolResult>;
};
let registry: Map<string, Registered>;

function register(context = member) {
  registry = new Map();
  registerReadTools(
    {
      registerTool: (
        name: string,
        config: Registered["config"],
        handler: Registered["handler"],
      ) => {
        expect(registry.has(name)).toBe(false);
        registry.set(name, { config, handler });
      },
    } as unknown as McpServer,
    context,
  );
}

async function call(name: string, input: unknown = {}) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool.handler(input);
}

async function result(name: string, input: unknown = {}) {
  const response = await call(name, input);
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  return (response.structuredContent as { result: unknown } | undefined)?.result;
}

async function status(name: string, input: unknown) {
  const response = await call(name, input);
  expect(response.isError).toBe(true);
  const content = response.content[0];
  if (content.type !== "text") throw new Error("Expected a text error");
  return (JSON.parse(content.text) as { status: number }).status;
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const model of Object.values(db)) {
    if (typeof model === "function") continue;
    model.findMany.mockResolvedValue([]);
    model.findUnique.mockResolvedValue(null);
    model.findFirst.mockResolvedValue(null);
    model.groupBy.mockResolvedValue([]);
    model.count.mockResolvedValue(0);
  }
  db.$queryRaw.mockResolvedValue([]);
  vi.mocked(searchWorkspace).mockResolvedValue({
    results: [],
    degraded: [],
    semantic: false,
    candidateLimit: 50,
  });
  register();
});

const listInputs: [string, Record<string, unknown>][] = [
  ["list_room_bookings", {}],
  ["list_equipment_allocations", {}],
  ["list_campuses", {}],
  ["list_buildings", {}],
  ["list_rooms", {}],
  ["list_locations", {}],
  ["list_equipment_models", {}],
  ["list_equipment", {}],
  ["list_stock", {}],
  ["list_events", {}],
  ["list_tickets", {}],
  ["list_assignment_principals", {}],
  ["list_tasks", {}],
  ["list_projects", {}],
  ["list_board", { kind: "task", lane: "BACKLOG" }],
  ["list_notes", {}],
  ["list_note_tags", {}],
  ["list_time_entries", { isoWeek: "2026-W45" }],
  ["list_vendors", {}],
  ["list_attachments", { roomId: "room" }],

  ["list_activity", {}],
  ["list_notifications", {}],
];
const entityReads = [
  "room_booking",
  "equipment_allocation",
  "campus",
  "building",
  "room",
  "location",
  "equipment_model",
  "equipment",
  "stock_item",
  "event",
  "ticket",
  "task",
  "note",
  "time_entry",
  "vendor",
  "attachment",
  "notification",
];

describe("read-only MCP coverage", () => {
  it("publishes every tool schema and calls reused schemas through the real SDK", async () => {
    const server = new McpServer({ name: "read-tools-test", version: "1" });
    registerReadTools(server, member);
    const client = new Client({ name: "read-tools-client", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...registry.keys()].sort());
      for (const name of ["list_stock", "list_tasks", "list_notes", "list_projects"]) {
        const response = await client.callTool({ name, arguments: {} });
        expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      }
      const kinds = await client.callTool({ name: "list_device_kinds", arguments: {} });
      expect(kinds.isError, JSON.stringify(kinds.content)).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("registers the complete read-only surface with no user-management, authentication or transfer tools", () => {
    const names = [
      ...listInputs.map(([name]) => name),
      ...entityReads.map((name) => `get_${name}`),
      "get_project",
      "list_device_kinds",
      "get_allowed_actions",
      "check_booking_conflicts",
      "find_free_slot",
      "get_timesheet",
      "get_running_timer",
      "search_workspace",
    ];
    expect([...registry.keys()].sort()).toEqual(names.sort());
    for (const { config } of registry.values()) {
      expect(config.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
    }
    expect(
      [...registry.keys()].some((name) =>
        /user|auth|admin|export|import|token|invite|role/.test(name),
      ),
    ).toBe(false);
  });

  it.each(listInputs)("%s executes with a read-only MEMBER token", async (name, input) => {
    if (name === "list_activity") {
      expect(await status(name, input)).toBe(403);
      return;
    }
    expect(await result(name, input)).toMatchObject({ items: [], nextOffset: null });
  });

  it.each(entityReads)("get_%s maps a missing entity to not found", async (entity) => {
    expect(await status(`get_${entity}`, { id: "missing" })).toBe(404);
  });

  it("gets project details by slug and does not silently invent an ID lookup", async () => {
    expect(await status("get_project", { slug: "missing" })).toBe(404);
    expect(db.project.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: "missing" } }),
    );
  });

  it("pages duplicate-named rooms with an ID tiebreak and one lookahead row", async () => {
    db.room.findMany.mockResolvedValue([
      { id: "b", name: "Studio", _count: { equipment: 0 } },
      { id: "c", name: "Studio", _count: { equipment: 0 } },
      { id: "d", name: "Studio", _count: { equipment: 0 } },
    ]);
    expect(await result("list_rooms", { offset: 1, limit: 2 })).toMatchObject({
      items: [
        { id: "b", name: "Studio" },
        { id: "c", name: "Studio" },
      ],
      nextOffset: 3,
    });
    expect(db.room.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 1, take: 3, orderBy: [{ name: "asc" }, { id: "asc" }] }),
    );
    db.room.findMany.mockResolvedValue([{ id: "d", name: "Studio", _count: { equipment: 0 } }]);
    expect(await result("list_rooms", { offset: 3, limit: 2 })).toMatchObject({
      items: [{ id: "d" }],
      nextOffset: null,
    });
  });

  it("preserves filters, ISO instants and per-domain page bounds", async () => {
    await result("list_tasks", {
      projectId: "project",
      statuses: ["TODO"],
      assigneeId: "person",
      dueFrom: "2026-11-09T09:00:00+01:00",
      offset: 10,
      limit: 5,
    });
    expect(db.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 6,
        where: expect.objectContaining({
          projectId: "project",
          status: { in: ["TODO"] },
          assignees: { some: { userId: "person" } },
          dueAt: { gte: new Date("2026-11-09T08:00:00Z") },
        }),
      }),
    );
    await result("list_stock", { locationId: "shelf", includeUnassigned: false, limit: 1 });
    expect(db.inventoryItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2, where: { locationId: "shelf" } }),
    );
    await result("list_events", { from: "2026-11-09T08:00:00Z", to: "2026-11-09T09:00:00Z" });
    expect(db.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            { endsAt: { gt: new Date("2026-11-09T08:00:00Z") } },
            { startsAt: { lt: new Date("2026-11-09T09:00:00Z") } },
          ],
        }),
      }),
    );
  });

  it("filters tasks to the required lane before stable database pagination", async () => {
    await result("list_board", {
      kind: "task",
      lane: "BACKLOG",
      projectId: "project",
      assigneeId: "person",
      offset: 7,
      limit: 3,
    });
    expect(db.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "project",
          assignees: { some: { userId: "person" } },
          status: { in: ["BACKLOG", "TODO"] },
        },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        skip: 7,
        take: 4,
      }),
    );
    expect(await status("list_board", { kind: "task" })).toBe(422);
  });

  it("filters ticket lane/project/assignee in SQL before deterministic paging", async () => {
    await result("list_board", {
      kind: "ticket",
      lane: "IN_REVIEW",
      projectId: "project",
      assigneeId: "person",
      offset: 9,
      limit: 2,
    });
    const query = db.$queryRaw.mock.calls[0][0] as { sql: string; values: unknown[] };
    expect(query.sql).toContain("WHERE kind = 'TICKET' AND lane = ?");
    expect(query.sql).toContain("= ANY(assignee_ids)");
    expect(query.sql).toContain('task."projectId" = ?');
    expect(query.sql.indexOf('task."projectId"')).toBeLessThan(query.sql.indexOf("LIMIT"));
    expect(query.sql).toContain("ORDER BY sort_priority ASC NULLS LAST, updated_at DESC, id ASC");
    expect(query.sql).toContain("LIMIT ? OFFSET ?");
    expect(query.values).toEqual(["IN_REVIEW", "person", "project", 3, 9]);
  });

  it.each([
    ["list_rooms", { offset: -1 }],
    ["list_rooms", { limit: 101 }],
    ["list_events", { from: "2026-11-09T10:00" }],
    ["list_events", { from: "2026-11-09T10:00:00Z", to: "2026-11-09T09:00:00Z" }],
    ["list_attachments", {}],
    ["list_attachments", { roomId: "r", ticketId: "t" }],
    ["get_timesheet", { isoWeek: "2025-W53" }],
    ["list_time_entries", { isoWeek: "2026-W00" }],
    ["list_activity", { entityTypes: ["notification"] }],
  ])("%s rejects invalid input before querying", async (name, input) => {
    expect(await status(name as string, input)).toBe(422);
    expect(db.room.findMany).not.toHaveBeenCalled();
    expect(db.event.findMany).not.toHaveBeenCalled();
    expect(db.attachment.findMany).not.toHaveBeenCalled();
    expect(db.timeEntry.findMany).not.toHaveBeenCalled();
  });

  it("keeps assignment principals to active IDs and human labels", async () => {
    await result("list_assignment_principals", { limit: 2 });
    expect(db.user.findMany).toHaveBeenCalledWith({
      skip: 0,
      take: 3,
      where: { isActive: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: { id: true, name: true, initials: true },
    });
  });

  it("does not apply an invented author-only rule to shared notes", async () => {
    db.note.findUnique.mockResolvedValue({
      id: "shared",
      authorId: "someone-else",
      title: "Shared instructions",
      body: "Read me",
    });
    expect(await result("get_note", { id: "shared" })).toMatchObject({
      authorId: "someone-else",
      title: "Shared instructions",
    });
  });

  it("scopes notifications to the caller even if another userId is supplied", async () => {
    await result("list_notifications", { userId: "other", unreadOnly: true });
    expect(db.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "member", readAt: null }, skip: 0, take: 51 }),
    );
    expect(await status("get_notification", { id: "other-notification", userId: "other" })).toBe(
      404,
    );
    expect(db.notification.findFirst).toHaveBeenCalledWith({
      where: { id: "other-notification", userId: "member" },
    });
  });

  it.each(["get_running_timer", "get_time_entry", "get_timesheet", "list_time_entries"])(
    "%s refuses a MEMBER reading another person's time",
    async (name) => {
      expect(await status(name, { userId: "other", id: "entry", isoWeek: "2026-W45" })).toBe(403);
      expect(db.timeEntry.findMany).not.toHaveBeenCalled();
      expect(db.timeEntry.findFirst).not.toHaveBeenCalled();
    },
  );

  it("requires explicit permission for ADMIN cross-user reads while keeping notifications own-only", async () => {
    expect(await status("get_running_timer", { userId: "other" })).toBe(403);
    db.user.findUnique.mockResolvedValue({
      ...member.user,
      role: "ADMIN",
      isActive: true,
      permissions: [{ permission: "time.viewOthers" }],
    });
    register({ ...member, user: { ...member.user, role: "ADMIN" } });
    expect(await result("get_running_timer", { userId: "other" })).toBeNull();
    expect(db.timeEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "other", endsAt: null } }),
    );
    await result("list_time_entries", { userId: "other", isoWeek: "2026-W45", limit: 1 });
    expect(db.timeEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "other" }), take: 2 }),
    );
    await status("get_notification", { id: "notification", userId: "other" });
    expect(db.notification.findFirst).toHaveBeenCalledWith({
      where: { id: "notification", userId: "member" },
    });
  });

  it("redacts actor emails while applying time ownership and exposing accountability", async () => {
    db.user.findUnique.mockResolvedValue({
      ...member.user,
      role: "ADMIN",
      isActive: true,
      permissions: [],
    });
    db.activityLog.findMany.mockResolvedValueOnce([]).mockResolvedValue([
      {
        id: "log",
        action: "TaskCreated",
        entityType: "task",
        entityId: "task",
        actorId: "actor",
        actorSnapshot: {
          name: "Actor",
          initials: "AC",
          email: "private@example.invalid",
          via: "via MCP (Synthetic agent)",
          tokenId: "synthetic-token",
        },
        data: { title: "Inspect projector", private: "not returned" },
        occurredAt: new Date("2026-11-09T08:00:00Z"),
      },
    ]);
    const output = await result("list_activity");
    expect(output).toMatchObject({
      items: [
        {
          title: "Inspect projector",
          actor: {
            name: "Actor",
            initials: "AC",
            via: "via MCP (Synthetic agent)",
            tokenId: "synthetic-token",
          },
          occurredAt: { iso: "2026-11-09T08:00:00.000Z", berlin: expect.any(String) },
        },
      ],
    });
    expect(JSON.stringify(output)).not.toMatch(/email|private|actorSnapshot/);
    expect(db.activityLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [
            {
              OR: [
                { NOT: { entityType: { equals: "timeEntry", mode: "insensitive" } } },
                { entityType: { equals: "timeEntry", mode: "insensitive" }, entityId: { in: [] } },
              ],
            },
            {
              OR: [
                { entityType: { not: "user" } },
                {
                  action: {
                    in: ["TimesheetViewed", "UserPermissionGranted", "UserPermissionRevoked"],
                  },
                },
              ],
            },
          ],
          entityType: { in: expect.arrayContaining(["user", "timeEntry"]) },
        },
      }),
    );
    expect(db.activityLog.findMany.mock.lastCall?.[0].where.entityType.in).not.toContain(
      "notification",
    );
  });

  it("forwards ranked search limits and reports optional semantic/degraded state", async () => {
    vi.mocked(searchWorkspace).mockResolvedValue({
      results: [],
      degraded: ["dense"],
      semantic: true,
      candidateLimit: 50,
    });
    expect(
      await result("search_workspace", { q: "mixer", sourceTypes: ["EQUIPMENT"], limit: 7 }),
    ).toMatchObject({ degraded: ["dense"], semantic: true, candidateLimit: 50 });
    expect(searchWorkspace).toHaveBeenCalledWith("mixer", { sourceTypes: ["EQUIPMENT"], limit: 7 });
  });
});

describe("booking reads", () => {
  const from = "2026-11-09T08:00:00Z";
  const to = "2026-11-09T13:00:00Z";
  const booking = (startsAt: string, endsAt: string) => ({
    id: "booking",
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    event: { id: "event", title: "Lecture" },
  });

  beforeEach(() => {
    db.room.findUnique.mockResolvedValue({ id: "room", name: "Auditorium", status: "ALL_GOOD" });
    db.equipment.findUnique.mockResolvedValue({
      id: "equipment",
      name: "Microphone",
      assetTag: "MIC-1",
      status: "OPERATIONAL",
      mobility: "POOLED",
      ports: [],
      category: "MICROPHONE",
      kind: {
        id: "microphone-kind",
        name: "Microphone",
        systemKey: "microphone",
        group: { id: "audio-group", name: "Audio", position: 5 },
      },
    });
  });

  it("uses half-open overlap and explicit edit exclusion for conflict checks", async () => {
    db.eventRoomBooking.findMany.mockResolvedValue([booking(from, "2026-11-09T09:00:00Z")]);
    expect(
      await result("check_booking_conflicts", {
        kind: "room",
        id: "room",
        startsAt: from,
        endsAt: to,
        excludeId: "editing",
      }),
    ).toMatchObject({
      resource: { id: "room", name: "Auditorium" },
      conflicts: [{ bookingId: "booking", eventTitle: "Lecture" }],
    });
    expect(db.eventRoomBooking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          roomId: "room",
          cancelled: false,
          startsAt: { lt: new Date(to) },
          endsAt: { gt: new Date(from) },
          id: { not: "editing" },
        },
      }),
    );
  });

  it("pages booking occupancy independently of parent event times and status", async () => {
    await result("list_room_bookings", { roomId: "room", from, to, offset: 7, limit: 2 });
    expect(db.eventRoomBooking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          roomId: "room",
          eventId: undefined,
          cancelled: false,
          endsAt: { gt: new Date(from) },
          startsAt: { lt: new Date(to) },
        },
        include: expect.objectContaining({
          event: { select: { id: true, title: true, status: true } },
        }),
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
        skip: 7,
        take: 3,
      }),
    );
    await result("list_equipment_allocations", {
      equipmentId: "equipment",
      cancelled: true,
      from,
      to,
    });
    expect(db.equipmentAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          equipmentId: "equipment",
          eventId: undefined,
          cancelled: true,
          endsAt: { gt: new Date(from) },
          startsAt: { lt: new Date(to) },
        },
      }),
    );
    expect(db.event.findMany).not.toHaveBeenCalled();
  });

  it.each([
    [[], "2026-11-09T08:00:00.000Z"],
    [[booking("2026-11-09T07:00:00Z", "2026-11-09T09:00:00Z")], "2026-11-09T09:00:00.000Z"],
    [[booking("2026-11-09T09:00:00Z", "2026-11-09T10:00:00Z")], "2026-11-09T08:00:00.000Z"],
    [[booking(from, to)], null],
  ])(
    "finds the earliest slot without treating adjacent bookings as conflicts",
    async (bookings, startsAt) => {
      db.eventRoomBooking.findMany.mockResolvedValue(bookings);
      const output = await result("find_free_slot", {
        roomIds: ["room"],
        from,
        to,
        durationMinutes: 60,
      });
      expect(output).toMatchObject({
        slot: startsAt ? { startsAt: { iso: startsAt } } : null,
        rooms: [{ id: "room", name: "Auditorium" }],
      });
    },
  );

  it("merges blocking intervals across rooms and equipment", async () => {
    db.eventRoomBooking.findMany.mockResolvedValue([booking(from, "2026-11-09T09:30:00Z")]);
    db.equipmentAllocation.findMany.mockResolvedValue([
      booking("2026-11-09T09:00:00Z", "2026-11-09T10:00:00Z"),
    ]);
    expect(
      await result("find_free_slot", {
        roomIds: ["room"],
        equipmentIds: ["equipment"],
        from,
        to,
        durationMinutes: 60,
      }),
    ).toMatchObject({
      slot: {
        startsAt: { iso: "2026-11-09T10:00:00.000Z" },
        endsAt: { iso: "2026-11-09T11:00:00.000Z" },
      },
    });
  });

  it("rejects missing resources rather than presenting them as available", async () => {
    db.room.findUnique.mockResolvedValue(null);
    expect(
      await status("find_free_slot", { roomIds: ["missing"], from, to, durationMinutes: 60 }),
    ).toBe(404);
    expect(
      await status("check_booking_conflicts", {
        kind: "room",
        id: "missing",
        startsAt: from,
        endsAt: to,
      }),
    ).toBe(404);
    expect(db.eventRoomBooking.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { roomIds: [], from, to, durationMinutes: 60 },
    { roomIds: ["room"], from, to, durationMinutes: 0 },
    { roomIds: ["room"], from, to: from, durationMinutes: 60 },
    { roomIds: ["room"], from, to: "2027-01-01T08:00:00Z", durationMinutes: 60 },
  ])("rejects invalid or excessive free-slot windows", async (input) => {
    expect(await status("find_free_slot", input)).toBe(422);
    expect(db.eventRoomBooking.findMany).not.toHaveBeenCalled();
  });
});
