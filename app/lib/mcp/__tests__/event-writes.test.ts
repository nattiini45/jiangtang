import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configuredCalendarFixture } from "../../../../test/calendar-config";

configuredCalendarFixture();
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerEventWrites } from "~/lib/mcp/event-writes.server";
import { registerReadTools } from "~/lib/mcp/read-tools.server";
import { getEventDetail } from "~/domains/events/events.queries.server";
import { serializeMcp } from "~/lib/mcp/tools.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { db } from "~/lib/db.server";
import * as eventMutations from "~/domains/events/events.mutations.server";
import { eventAllowedActions } from "~/domains/events/events.actions";
import { runWithLocale } from "~/i18n/request-locale.server";
import * as realtime from "~/lib/realtime/emit.server";
import {
  roomBookingExactSchema,
  allocationSchema,
  serviceWindowSchema,
} from "~/domains/events/events.schema";

const run = `mcp-event-${crypto.randomUUID()}`;
const eventIds: string[] = [];
const eventUids: string[] = [];
const ticketIds: string[] = [];
const fixtures = { userId: "", campusId: "", roomId: "", equipmentId: "" };
const principal: McpContext = {
  user: {
    id: "",
    name: "Synthetic MCP member",
    email: `${run}@example.test`,
    initials: "MM",
    role: "MEMBER",
  },
  token: { id: `${run}-token`, name: "Synthetic scheduling agent", scope: "READ_WRITE" },
};
let client: Client;
let server: McpServer;
const interval = {
  startsAt: "2026-10-25T02:30:17.250+02:00",
  endsAt: "2026-10-25T02:15:29.750+01:00",
};
const changes = vi.spyOn(realtime, "emitChange");

async function connect(context: McpContext) {
  const server = new McpServer({ name: "event-write-tests", version: "1" });
  registerEventWrites(server, context);
  const client = new Client({ name: "event-write-tests", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, server };
}

async function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

async function success(name: string, args: Record<string, unknown>) {
  const result = await call(name, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return (result.structuredContent as { result: Record<string, unknown> }).result;
}

async function makeEvent(title = `${run} event`, booking = false) {
  const result = await success(booking ? "create_event_with_booking" : "create_event", {
    input: { title, ...interval },
    ...(booking ? { booking: { roomId: fixtures.roomId, ...interval } } : {}),
  });
  eventIds.push(String(result.id));
  eventUids.push(String(result.uid));
  return result;
}

beforeAll(async () => {
  const user = await db.user.create({
    data: { email: principal.user.email, name: principal.user.name },
  });
  fixtures.userId = user.id;
  principal.user.id = user.id;
  const campus = await db.campus.create({ data: { name: run, slug: run } });
  fixtures.campusId = campus.id;
  const room = await db.room.create({
    data: { name: `${run} room`, slug: run, campusId: campus.id },
  });
  fixtures.roomId = room.id;
  const equipment = await db.equipment.create({
    data: {
      name: `${run} projector`,
      category: "PROJECTOR",
      mobility: "POOLED",
      status: "OPERATIONAL",
    },
  });
  fixtures.equipmentId = equipment.id;
  ({ client, server } = await connect(principal));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  vi.restoreAllMocks();
  await db.ticket.deleteMany({ where: { id: { in: ticketIds } } });
  await db.eventRoomBooking.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.equipmentAllocation.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.serviceWindow.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.calendarOutbox.deleteMany({ where: { eventUid: { in: eventUids } } });
  await db.event.deleteMany({ where: { id: { in: eventIds } } });
  await db.equipment.deleteMany({ where: { id: fixtures.equipmentId } });
  await db.room.deleteMany({ where: { id: fixtures.roomId } });
  await db.campus.deleteMany({ where: { id: fixtures.campusId } });
  await db.user.deleteMany({ where: { id: fixtures.userId } });
});

describe("MCP event writer boundary", () => {
  it.each(["en", "de"] as const)(
    "discovers named reopen metadata and preserves generic update_event in %s",
    async (locale) => {
      await runWithLocale(locale, async () => {
        const event = await makeEvent(`${run} reopen ${locale}`);
        const eventId = String(event.id);
        await success("cancel_event", { id: eventId, confirm: true });
        const room = await db.eventRoomBooking.create({
          data: {
            eventId,
            roomId: fixtures.roomId,
            startsAt: new Date(interval.startsAt),
            endsAt: new Date(interval.endsAt),
            cancelled: true,
          },
        });
        const equipment = await db.equipmentAllocation.create({
          data: {
            eventId,
            equipmentId: fixtures.equipmentId,
            startsAt: new Date(interval.startsAt),
            endsAt: new Date(interval.endsAt),
            cancelled: true,
          },
        });
        for (const scope of ["READ_ONLY", "READ_WRITE"] as const) {
          const context = { ...principal, token: { ...principal.token, scope } };
          const readerServer = new McpServer({ name: "event-reopen-read", version: "1" });
          const reader = new Client({ name: "event-reopen-read", version: "1" });
          registerReadTools(readerServer, context);
          const [a, b] = InMemoryTransport.createLinkedPair();
          await readerServer.connect(a);
          await reader.connect(b);
          try {
            const result = await reader.callTool({ name: "get_event", arguments: { id: eventId } });
            expect(result.isError).not.toBe(true);
            const detail = (result.structuredContent as { result: Record<string, unknown> }).result;
            expect(detail.allowedActions).toEqual(eventAllowedActions("CANCELLED"));
          } finally {
            await reader.close();
            await readerServer.close();
          }
        }
        const readOnly = await connect({
          ...principal,
          token: { ...principal.token, scope: "READ_ONLY" },
        });
        const saved = await db.event.findUniqueOrThrow({ where: { id: eventId } });
        const logs = await db.activityLog.count({ where: { entityId: eventId } });
        const ops = await db.calendarOutbox.count({ where: { eventUid: saved.uid } });
        const emitted = changes.mock.calls.length;
        try {
          const refused = await readOnly.client.callTool({
            name: "update_event",
            arguments: {
              id: "missing",
              input: { title: "Synthetic reopen", ...interval, status: "PLANNED" },
              confirm: true,
            },
          });
          expect(refused.isError).toBe(true);
          expect(JSON.stringify(refused.content)).toContain("403");
        } finally {
          await readOnly.client.close();
          await readOnly.server.close();
        }
        expect(
          (
            await call("update_event", {
              id: eventId,
              input: { title: "Synthetic reopen", ...interval, status: "PLANNED" },
            })
          ).isError,
        ).toBe(true);
        expect(await db.event.findUniqueOrThrow({ where: { id: eventId } })).toEqual(saved);
        expect(await db.activityLog.count({ where: { entityId: eventId } })).toBe(logs);
        expect(await db.calendarOutbox.count({ where: { eventUid: saved.uid } })).toBe(ops);
        expect(changes.mock.calls).toHaveLength(emitted);
        const result = await success("update_event", {
          id: eventId,
          input: { title: "Synthetic reopen", ...interval, status: "PLANNED" },
          confirm: true,
        });
        expect(result).toMatchObject({ status: "PLANNED", allowedActions: [] });
        expect(await db.eventRoomBooking.findUniqueOrThrow({ where: { id: room.id } })).toEqual(
          room,
        );
        expect(
          await db.equipmentAllocation.findUniqueOrThrow({ where: { id: equipment.id } }),
        ).toEqual(equipment);
        expect(await db.activityLog.count({ where: { entityId: eventId } })).toBe(logs + 1);
        expect(await db.calendarOutbox.count({ where: { eventUid: saved.uid } })).toBe(ops + 1);
        expect(changes.mock.calls.slice(emitted)).toEqual([
          [{ entityType: "event", id: eventId, op: "updated" }],
        ]);
        expect((await getEventDetail(eventId))?.allowedActions).toEqual(
          eventAllowedActions("PLANNED"),
        );
      });
    },
  );

  it("publishes all writes with destructive annotations and ISO input schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(14);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === false)).toBe(true);
    for (const name of [
      "cancel_event",
      "cancel_room_booking",
      "cancel_equipment_allocation",
      "remove_service_window",
      "update_event",
      "transition_ticket",
      "move_ticket",
    ]) {
      expect(tools.find((tool) => tool.name === name)?.annotations?.destructiveHint).toBe(true);
    }
    expect(
      JSON.stringify(tools.find((tool) => tool.name === "create_event")?.inputSchema),
    ).toContain('"format":"date-time"');
  });

  it("blocks read-only writes before calling the domain", async () => {
    const spy = vi.spyOn(eventMutations, "createEvent");
    const readOnly = await connect({
      ...principal,
      token: { ...principal.token, scope: "READ_ONLY" },
    });
    try {
      const result = await readOnly.client.callTool({
        name: "create_event",
        arguments: { input: { title: run, ...interval } },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("403");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      await readOnly.client.close();
      await readOnly.server.close();
    }
  });

  it("requires explicit true for every cancellation and removal", async () => {
    const cancel = vi.spyOn(eventMutations, "cancelEvent");
    const remove = vi.spyOn(eventMutations, "removeServiceWindow");
    try {
      for (const confirm of [undefined, false]) {
        for (const name of [
          "cancel_event",
          "cancel_room_booking",
          "cancel_equipment_allocation",
          "remove_service_window",
        ]) {
          const result = await call(name, {
            id: "not-a-real-row",
            eventId: "not-an-event",
            confirm,
          });
          expect(result.isError).toBe(true);
        }
      }
      expect(cancel).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally {
      cancel.mockRestore();
      remove.mockRestore();
    }
  });

  it("rejects local times, invalid intervals and schema failures without mutating", async () => {
    const spy = vi.spyOn(eventMutations, "createEvent");
    try {
      for (const input of [
        { title: run, startsAt: "2026-07-01T10:00", endsAt: "2026-07-01T11:00" },
        { title: run, startsAt: interval.endsAt, endsAt: interval.startsAt },
        { title: "", ...interval },
        { title: run, ...interval, startsAtInstant: "2026-10-25T00:30:00Z" },
      ]) {
        expect((await call("create_event", { input })).isError).toBe(true);
      }
      expect(spy).not.toHaveBeenCalled();
      expect(
        (await call("create_ticket", { input: { title: run, occurredAt: "2026-07-01" } })).isError,
      ).toBe(true);
      expect(
        (await call("create_ticket", { input: { title: run, status: "RESOLVED" } })).isError,
      ).toBe(true);
      expect(
        (await call("move_ticket", { id: "missing", lane: "DONE", confirm: true })).isError,
      ).toBe(true);
      expect(
        (await call("move_ticket", { id: "missing", lane: "IN_REVIEW", confirm: true })).isError,
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("validates exact-instant agreement for every event-domain time schema", () => {
    const input = {
      title: run,
      roomId: fixtures.roomId,
      equipmentId: fixtures.equipmentId,
      startsAt: "2026-10-25T02:30",
      endsAt: "2026-10-25T02:15",
      startsAtInstant: "2026-10-25T00:30:17.250Z",
      endsAtInstant: "2026-10-25T01:15:29.750Z",
    };
    for (const schema of [roomBookingExactSchema, allocationSchema, serviceWindowSchema]) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(
        schema.safeParse({ ...input, startsAtInstant: "2026-10-25T03:30:17.250Z" }).success,
      ).toBe(false);
    }
  });
});

describe("MCP event writer transactions", () => {
  it("keeps disabled writes out of the queue and exposes canonical unconfigured read metadata", async () => {
    vi.stubEnv("CALDAV_URL", "");
    const readerServer = new McpServer({ name: "publication-read", version: "1" });
    const reader = new Client({ name: "publication-read", version: "1" });
    registerReadTools(readerServer, principal);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await readerServer.connect(a);
    await reader.connect(b);
    try {
      const event = await makeEvent(`${run} disabled`);
      const initial = await makeEvent(`${run} disabled initial`, true);
      await success("update_event", {
        id: event.id,
        input: { title: `${run} disabled edit`, ...interval },
        confirm: true,
      });
      const booking = await success("add_room_booking", {
        eventId: event.id,
        input: {
          roomId: fixtures.roomId,
          startsAt: "2026-10-26T08:00:00Z",
          endsAt: "2026-10-26T09:00:00Z",
        },
      });
      await success("cancel_room_booking", { eventId: event.id, id: booking.id, confirm: true });
      await success("cancel_event", { id: event.id, confirm: true });
      await success("update_event", {
        id: initial.id,
        input: { title: `${run} disabled cancelled`, ...interval, status: "CANCELLED" },
        confirm: true,
      });
      expect(
        await db.calendarOutbox.count({
          where: { eventUid: { in: [String(event.uid), String(initial.uid)] } },
        }),
      ).toBe(0);
      const result = await reader.callTool({ name: "get_event", arguments: { id: event.id } });
      expect(result.isError).not.toBe(true);
      const detail = (result.structuredContent as { result: Record<string, unknown> }).result;
      expect(detail).toEqual(serializeMcp(await getEventDetail(String(event.id))));
      expect(detail.calendarSync).toEqual({ configured: false, latest: null });
    } finally {
      vi.stubEnv("CALDAV_URL", "https://calendar.example.test/collection/");
      await reader.close();
      await readerServer.close();
    }
  });

  it("lets a member create/update/cancel events and manage every child with exact DST-fold instants", async () => {
    const event = await makeEvent(`${run} lifecycle`);
    const eventId = String(event.id);
    const persisted = await db.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(persisted.startsAt.toISOString()).toBe("2026-10-25T00:30:17.250Z");
    expect(persisted.endsAt.toISOString()).toBe("2026-10-25T01:15:29.750Z");
    await success("update_event", {
      id: eventId,
      input: { title: `${run} updated`, ...interval },
      confirm: true,
    });
    const booking = await success("add_room_booking", {
      eventId,
      input: { roomId: fixtures.roomId, ...interval },
    });
    const allocation = await success("add_equipment_allocation", {
      eventId,
      input: { equipmentId: fixtures.equipmentId, ...interval },
    });
    const window = await success("add_service_window", {
      eventId,
      input: { roomId: fixtures.roomId, kind: "SETUP", ...interval },
    });
    expect(booking.label).toBe(`${run} updated`);
    expect(allocation.label).toBe(`${run} updated`);
    expect(window.label).toBe(`${run} updated`);
    for (const row of [
      await db.eventRoomBooking.findUniqueOrThrow({ where: { id: String(booking.id) } }),
      await db.equipmentAllocation.findUniqueOrThrow({ where: { id: String(allocation.id) } }),
      await db.serviceWindow.findUniqueOrThrow({ where: { id: String(window.id) } }),
    ]) {
      expect(row.startsAt.toISOString()).toBe("2026-10-25T00:30:17.250Z");
      expect(row.endsAt.toISOString()).toBe("2026-10-25T01:15:29.750Z");
    }
    await success("cancel_room_booking", { eventId, id: booking.id, confirm: true });
    await success("cancel_equipment_allocation", { eventId, id: allocation.id, confirm: true });
    await success("remove_service_window", { eventId, id: window.id, confirm: true });
    expect(await db.serviceWindow.findUnique({ where: { id: String(window.id) } })).toBeNull();
    await success("cancel_event", { id: eventId, confirm: true });
    expect((await db.event.findUniqueOrThrow({ where: { id: eventId } })).status).toBe("CANCELLED");
    const logs = await db.activityLog.findMany({
      where: {
        entityId: { in: [eventId, String(booking.id), String(allocation.id), String(window.id)] },
      },
    });
    expect(logs.map((log) => log.action)).toEqual(
      expect.arrayContaining([
        "EventCreated",
        "EventUpdated",
        "RoomBooked",
        "EquipmentAllocated",
        "ServiceWindowAdded",
        "RoomBookingCancelled",
        "EquipmentDeallocated",
        "ServiceWindowRemoved",
        "EventCancelled",
      ]),
    );
    for (const log of logs) {
      expect(log.actorId).toBe(principal.user.id);
      expect(log.actorSnapshot).toMatchObject({
        via: "via MCP (Synthetic scheduling agent)",
        tokenId: principal.token.id,
      });
    }
    expect(changes).toHaveBeenCalledWith({ entityType: "event", id: eventId, op: "updated" });
    expect(changes).toHaveBeenCalledWith({
      entityType: "eventRoomBooking",
      id: booking.id,
      op: "created",
    });
    expect(changes).toHaveBeenCalledWith({
      entityType: "equipmentAllocation",
      id: allocation.id,
      op: "updated",
    });
  });

  it("returns the actual conflicting event, booking ID and ISO interval after rollback", async () => {
    const winner = await makeEvent(`${run} booked event`, true);
    const booking = await db.eventRoomBooking.findFirstOrThrow({
      where: { eventId: String(winner.id) },
    });
    const loser = await makeEvent(`${run} overlapping event`);
    const emittedBefore = changes.mock.calls.length;
    const rejected = await call("add_room_booking", {
      eventId: loser.id,
      input: { roomId: fixtures.roomId, ...interval },
    });
    expect(rejected.isError).toBe(true);
    const text = JSON.stringify(rejected.content);
    expect(text).toContain("409");
    expect(text).toContain(String(winner.label));
    expect(text).toContain(booking.id);
    expect(text).toContain("2026-10-25T00:30:17.250Z");
    expect(text).toContain("2026-10-25T01:15:29.750Z");
    expect(await db.eventRoomBooking.count({ where: { eventId: String(loser.id) } })).toBe(0);
    expect(changes.mock.calls).toHaveLength(emittedBefore);
    const title = `${run} atomic rejected`;
    const atomic = await call("create_event_with_booking", {
      input: { title, ...interval },
      booking: { roomId: fixtures.roomId, ...interval },
    });
    expect(atomic.isError).toBe(true);
    expect(JSON.stringify(atomic.content)).toContain(booking.id);
    expect(await db.event.count({ where: { title } })).toBe(0);
    expect(
      await db.activityLog.count({
        where: { action: "EventCreated", data: { path: ["title"], equals: title } },
      }),
    ).toBe(0);
    await success("cancel_room_booking", { eventId: winner.id, id: booking.id, confirm: true });
  });

  it("rejects equipment overlap with the existing allocation ID and emits no success change", async () => {
    const first = await makeEvent(`${run} equipment winner`);
    const second = await makeEvent(`${run} equipment loser`);
    const allocation = await success("add_equipment_allocation", {
      eventId: first.id,
      input: { equipmentId: fixtures.equipmentId, ...interval },
    });
    const emittedBefore = changes.mock.calls.length;
    const result = await call("add_equipment_allocation", {
      eventId: second.id,
      input: { equipmentId: fixtures.equipmentId, ...interval },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(String(allocation.id));
    expect(JSON.stringify(result.content)).toContain(String(first.label));
    expect(await db.equipmentAllocation.count({ where: { eventId: String(second.id) } })).toBe(0);
    expect(changes.mock.calls).toHaveLength(emittedBefore);
    await success("cancel_equipment_allocation", {
      eventId: first.id,
      id: allocation.id,
      confirm: true,
    });
  });

  it("lets exactly one concurrent conflicting atomic creation commit", async () => {
    const titles = [`${run} race one`, `${run} race two`];
    const results = await Promise.all(
      titles.map((title) =>
        call("create_event_with_booking", {
          input: { title, ...interval },
          booking: { roomId: fixtures.roomId, ...interval },
        }),
      ),
    );
    const saved = await db.event.findMany({ where: { title: { in: titles } } });
    for (const event of saved) {
      eventIds.push(event.id);
      eventUids.push(event.uid);
    }
    expect(results.filter((result) => result.isError === true)).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(await db.eventRoomBooking.count({ where: { eventId: saved[0].id } })).toBe(1);
    await success("cancel_event", { id: saved[0].id, confirm: true });
  });
});

describe("MCP ticket and board workflow", () => {
  it("retains, reads, edits, drops and reopens known fixes through the MCP boundary", async () => {
    const definition = await db.roomFunction.findUniqueOrThrow({
      where: { systemKey: "picture" },
      include: { kinds: true },
    });
    const before = await db.equipment.findUniqueOrThrow({ where: { id: fixtures.equipmentId } });
    await db.equipment.update({
      where: { id: fixtures.equipmentId },
      data: {
        roomId: fixtures.roomId,
        kindId: definition.kinds.find((kind) => kind.role === "CARRIER")!.kindId,
      },
    });
    const readerServer = new McpServer({ name: "known-fix-reader", version: "1" });
    registerReadTools(readerServer, principal);
    const reader = new Client({ name: "known-fix-reader", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await readerServer.connect(a);
    await reader.connect(b);
    try {
      const input = {
        title: `${run} known fix`,
        roomId: fixtures.roomId,
        functionId: definition.id,
      };
      const incident = await success("create_ticket", { input });
      ticketIds.push(String(incident.id));
      const rejected = await call("update_ticket", {
        id: incident.id,
        input: { ...input, resolution: "Not closed yet" },
      });
      expect(rejected.isError).toBe(true);
      await success("transition_ticket", {
        id: incident.id,
        input: { status: "RESOLVED", resolution: "Switched input", keepAsFix: true },
        confirm: true,
      });
      const repair = await success("create_ticket", {
        input: {
          ...input,
          type: "REPAIR",
          status: "RESOLVED",
          resolution: "Changed cable",
          keepAsFix: true,
        },
      });
      ticketIds.push(String(repair.id));
      const result = await reader.callTool({
        name: "get_room_functions",
        arguments: { roomId: fixtures.roomId },
      });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.structuredContent)).toContain("Switched input");
      expect(JSON.stringify(result.structuredContent)).toContain("Changed cable");
      await success("update_ticket", {
        id: incident.id,
        input: { ...input, keepAsFix: false, resolution: "Corrected help" },
      });
      expect(
        await db.ticket.findUniqueOrThrow({ where: { id: String(incident.id) } }),
      ).toMatchObject({ keepAsFix: false, resolution: "Corrected help" });
      await success("update_ticket", { id: incident.id, input: { ...input, keepAsFix: true } });
      await success("transition_ticket", {
        id: incident.id,
        input: { status: "OPEN" },
        confirm: true,
      });
      expect(
        await db.ticket.findUniqueOrThrow({ where: { id: String(incident.id) } }),
      ).toMatchObject({ keepAsFix: false, resolution: null });
    } finally {
      await reader.close();
      await readerServer.close();
      await db.equipment.update({
        where: { id: fixtures.equipmentId },
        data: { roomId: before.roomId, kindId: before.kindId },
      });
    }
  });
  it("creates, edits, starts, resolves through a lane and reopens a ticket with domain audit markers", async () => {
    const ticket = await success("create_ticket", {
      input: { title: `${run} ticket`, type: "INCIDENT", occurredAt: "2026-07-01T10:00:00+02:00" },
    });
    ticketIds.push(String(ticket.id));
    expect(ticket.label).toBe(`${run} ticket`);
    await success("update_ticket", {
      id: ticket.id,
      input: { title: `${run} edited ticket`, type: "REQUEST", assigneeIds: [principal.user.id] },
    });
    await success("transition_ticket", {
      id: ticket.id,
      input: { status: "IN_PROGRESS" },
      confirm: true,
    });
    await success("move_ticket", {
      id: ticket.id,
      lane: "DONE",
      resolution: "Synthetic repair completed",
      confirm: true,
    });
    const resolved = await db.ticket.findUniqueOrThrow({ where: { id: String(ticket.id) } });
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolution).toBe("Synthetic repair completed");
    expect(resolved.resolvedAt).not.toBeNull();
    const illegal = await call("transition_ticket", {
      id: ticket.id,
      input: { status: "RESOLVED", resolution: "Cannot resolve twice" },
      confirm: true,
    });
    expect(illegal.isError).toBe(true);
    await success("move_ticket", { id: ticket.id, lane: "BACKLOG", confirm: true });
    const reopened = await db.ticket.findUniqueOrThrow({ where: { id: String(ticket.id) } });
    expect(reopened.resolution).toBeNull();
    expect(reopened.resolvedAt).toBeNull();
    await success("transition_ticket", {
      id: ticket.id,
      input: { status: "CANCELLED" },
      confirm: true,
    });
    const logs = await db.activityLog.findMany({
      where: { entityType: "ticket", entityId: String(ticket.id) },
    });
    expect(logs.map((log) => log.action)).toEqual(
      expect.arrayContaining([
        "TicketCreated",
        "TicketUpdated",
        "TicketStarted",
        "TicketResolved",
        "TicketReopened",
        "TicketCancelled",
      ]),
    );
    expect(logs.every((log) => log.actorId === principal.user.id)).toBe(true);
    expect(
      logs.every(
        (log) => (log.actorSnapshot as { tokenId?: string }).tokenId === principal.token.id,
      ),
    ).toBe(true);
  });

  it("validates born-resolved dates as instants rather than lexical offsets", async () => {
    const ticket = await success("create_ticket", {
      input: {
        title: `${run} past repair`,
        type: "REPAIR",
        status: "RESOLVED",
        resolution: "Synthetic fix",
        occurredAt: "2026-10-25T02:30:00+02:00",
        resolvedAt: "2026-10-25T02:15:00+01:00",
      },
    });
    ticketIds.push(String(ticket.id));
    expect(
      (
        await db.ticket.findUniqueOrThrow({ where: { id: String(ticket.id) } })
      ).resolvedAt?.toISOString(),
    ).toBe("2026-10-25T01:15:00.000Z");
    const invalid = await call("create_ticket", {
      input: {
        title: `${run} invalid repair`,
        type: "REPAIR",
        status: "RESOLVED",
        resolution: "Synthetic fix",
        occurredAt: "2026-10-25T02:15:00+01:00",
        resolvedAt: "2026-10-25T02:30:00+02:00",
      },
    });
    expect(invalid.isError).toBe(true);
    expect(await db.ticket.count({ where: { title: `${run} invalid repair` } })).toBe(0);
  });
});
