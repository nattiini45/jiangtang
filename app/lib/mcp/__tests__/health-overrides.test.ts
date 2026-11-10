import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerEventWrites } from "~/lib/mcp/event-writes.server";
import { registerReadTools } from "~/lib/mcp/read-tools.server";
import { registerResources } from "~/lib/mcp/resources.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { db } from "~/lib/db.server";
import { RoomStatus, EquipmentStatus } from "~/generated/prisma/enums";
import {
  equipmentAllocationAction,
  roomBookingAction,
} from "~/domains/events/events.health-policy";
import { runWithLocale } from "~/i18n/request-locale.server";
import { t } from "~/i18n";

const run = `mcp_health_${crypto.randomUUID()}`;
const interval = { startsAt: "2043-06-01T10:00:00+02:00", endsAt: "2043-06-01T11:00:00+02:00" };
const context: McpContext = {
  user: { id: "", name: run, email: `${run}@example.test`, initials: "MH", role: "MEMBER" },
  token: { id: `${run}_token`, name: "Synthetic health checks", scope: "READ_WRITE" },
};
let client: Client;
let server: McpServer;
let eventId: string;
const rooms: Record<string, string> = {};
const equipment: Record<string, string> = {};

async function connect(principal: McpContext) {
  const server = new McpServer({ name: "health-overrides", version: "1" });
  registerEventWrites(server, principal);
  registerReadTools(server, principal);
  registerResources(server, principal);
  const client = new Client({ name: "health-overrides", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, server };
}

beforeAll(async () => {
  context.user.id = (await db.user.create({ data: { email: context.user.email, name: run } })).id;
  eventId = (
    await db.event.create({
      data: {
        title: run,
        startsAt: new Date(interval.startsAt),
        endsAt: new Date(interval.endsAt),
      },
    })
  ).id;
  for (const status of Object.values(RoomStatus))
    rooms[status] = (
      await db.room.create({ data: { slug: `${run}_${status}`, name: `${run}_${status}`, status } })
    ).id;
  for (const status of Object.values(EquipmentStatus))
    equipment[status] = (
      await db.equipment.create({
        data: { name: `${run}_${status}`, category: "OTHER", mobility: "POOLED", status },
      })
    ).id;
  ({ client, server } = await connect(context));
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  const where = { title: { startsWith: run } };
  const events = await db.event.findMany({ where });
  await db.eventRoomBooking.deleteMany({ where: { event: where } });
  await db.equipmentAllocation.deleteMany({ where: { event: where } });
  await db.calendarOutbox.deleteMany({
    where: { eventUid: { in: events.map((event) => event.uid) } },
  });
  await db.event.deleteMany({ where });
  await db.room.deleteMany({ where: { id: { in: Object.values(rooms) } } });
  await db.equipment.deleteMany({ where: { id: { in: Object.values(equipment) } } });
  await db.user.deleteMany({ where: { id: context.user.id } });
  await db.$disconnect();
});

async function result(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError).not.toBe(true);
  return (response.structuredContent as { result: Record<string, unknown> }).result;
}

async function resource(uri: string) {
  const response = await client.readResource({ uri });
  const content = response.contents[0];
  if (!("text" in content)) throw new Error("Expected a JSON text resource");
  return JSON.parse(content.text).result;
}

describe("MCP asset health override parity", () => {
  it("publishes strict optional boolean and string inputs on all three booking tools", async () => {
    const tools = (await client.listTools()).tools;
    for (const name of [
      "create_event_with_booking",
      "add_room_booking",
      "add_equipment_allocation",
    ]) {
      const tool = tools.find((tool) => tool.name === name)!;
      expect(tool.description).toContain("healthOverrideConfirmed:true");
      expect(tool.description).toContain("healthOverrideReason");
      const input = (
        tool.inputSchema.properties as Record<
          string,
          { properties: Record<string, { type: string }>; required: string[] }
        >
      )[name === "create_event_with_booking" ? "booking" : "input"];
      expect(input.properties.healthOverrideConfirmed.type).toBe("boolean");
      expect(input.properties.healthOverrideReason.type).toBe("string");
      expect(input.required).not.toContain("healthOverrideConfirmed");
      expect(input.required).not.toContain("healthOverrideReason");
    }
  });

  it("returns the same typed actions from tool and resource list/detail reads for every status", async () => {
    const roomList = (await result("list_rooms", { q: run })).items as Record<string, unknown>[];
    const equipmentList = (await result("list_equipment", { q: run })).items as Record<
      string,
      unknown
    >[];
    const roomCollection = await resource("jiangtang://collections/rooms");
    const equipmentCollection = await resource("jiangtang://collections/equipment");
    expect(roomCollection.items.length).toBeGreaterThan(0);
    expect(equipmentCollection.items.length).toBeGreaterThan(0);
    for (const item of roomCollection.items)
      expect(item.bookingAction).toEqual(roomBookingAction(item.status));
    for (const item of equipmentCollection.items)
      expect(item.allocationAction).toEqual(equipmentAllocationAction(item.status, item.mobility));
    for (const status of Object.values(RoomStatus)) {
      const id = rooms[status];
      const action = roomBookingAction(status);
      expect((await result("get_room", { id })).bookingAction).toEqual(action);
      expect((await resource(`jiangtang://rooms/${id}`)).bookingAction).toEqual(action);
      expect(roomList.find((room) => room.id === id)?.bookingAction).toEqual(action);
    }
    for (const status of Object.values(EquipmentStatus)) {
      const id = equipment[status];
      const action = equipmentAllocationAction(status, "POOLED");
      expect((await result("get_equipment", { id })).allocationAction).toEqual(action);
      expect((await resource(`jiangtang://equipment/${id}`)).allocationAction).toEqual(action);
      expect(equipmentList.find((equipment) => equipment.id === id)?.allocationAction).toEqual(
        action,
      );
    }
  });

  for (const tool of [
    "create_event_with_booking",
    "add_room_booking",
    "add_equipment_allocation",
  ] as const) {
    const allocation = tool === "add_equipment_allocation";
    const args = (override: Record<string, unknown>) => {
      const input = {
        ...interval,
        ...(allocation ? { equipmentId: equipment.FAULTY } : { roomId: rooms.OUT_OF_SERVICE }),
        ...override,
      };
      return tool === "create_event_with_booking"
        ? { input: { title: `${run} initial`, ...interval }, booking: input }
        : { eventId, input };
    };

    it.each([
      {},
      { healthOverrideConfirmed: false, healthOverrideReason: "Checked" },
      { healthOverrideConfirmed: true },
      { healthOverrideConfirmed: true, healthOverrideReason: "   " },
    ])(`${tool} refuses incomplete override %j without audit`, async (override) => {
      const before = await db.activityLog.count({ where: { actorId: context.user.id } });
      for (const locale of ["en", "de"] as const) {
        const response = await runWithLocale(locale, () =>
          client.callTool({ name: tool, arguments: args(override) }),
        );
        expect(response.isError).toBe(true);
        expect(JSON.parse(String((response.content as { text: string }[])[0].text))).toMatchObject({
          status: 422,
          detail: {
            transition: {
              currentState: allocation ? "FAULTY" : "OUT_OF_SERVICE",
              reason: {
                code: "HEALTH_OVERRIDE_REQUIRED",
                message: t(locale, "events.health.overrideRequired"),
              },
            },
          },
        });
      }
      expect(await db.activityLog.count({ where: { actorId: context.user.id } })).toBe(before);
    });

    it.each([
      { healthOverrideConfirmed: "true", healthOverrideReason: "Checked" },
      { healthOverrideConfirmed: 1, healthOverrideReason: "Checked" },
      { healthOverrideConfirmed: true, healthOverrideReason: 123 },
    ])(`${tool} does not coerce %j`, async (override) => {
      const response = await client.callTool({ name: tool, arguments: args(override) });
      expect(response.isError).toBe(true);
      expect(
        await db.activityLog.count({
          where: {
            actorId: context.user.id,
            action: allocation ? "EquipmentAllocated" : "RoomBooked",
          },
        }),
      ).toBe(0);
    });
  }

  it("uses the server-derived actor and trimmed reason in the existing atomic audits", async () => {
    for (const tool of [
      "create_event_with_booking",
      "add_room_booking",
      "add_equipment_allocation",
    ] as const) {
      const isAllocation = tool === "add_equipment_allocation";
      const input = {
        ...interval,
        ...(isAllocation
          ? { equipmentId: equipment.MAINTENANCE }
          : { roomId: rooms.OUT_OF_SERVICE }),
        healthOverrideConfirmed: true,
        healthOverrideReason: "  Approved synthetic exception  ",
        actorId: "forged",
        actor: { id: "forged" },
      };
      const data = await result(
        tool,
        tool === "create_event_with_booking"
          ? { input: { title: `${run} success`, ...interval }, booking: input }
          : { eventId, input },
      );
      const bookingId =
        tool === "create_event_with_booking"
          ? (data.bookings as { id: string }[])[0].id
          : String(data.id);
      const audit = await db.activityLog.findFirstOrThrow({
        where: { entityId: bookingId, action: isAllocation ? "EquipmentAllocated" : "RoomBooked" },
      });
      expect(audit.actorId).toBe(context.user.id);
      expect(audit.actorSnapshot).toMatchObject({
        name: run,
        tokenId: context.token.id,
        via: `via MCP (${context.token.name})`,
      });
      expect(audit.data).toMatchObject({
        healthOverride: {
          status: isAllocation ? "MAINTENANCE" : "OUT_OF_SERVICE",
          reason: "Approved synthetic exception",
        },
      });
      if (isAllocation) await db.equipmentAllocation.delete({ where: { id: bookingId } });
      else await db.eventRoomBooking.delete({ where: { id: bookingId } });
    }
  });

  it("keeps read-only permission and missing-event priority ahead of health policy", async () => {
    const readonly = await connect({ ...context, token: { ...context.token, scope: "READ_ONLY" } });
    try {
      const response = await readonly.client.callTool({
        name: "add_room_booking",
        arguments: { eventId: "missing", input: { roomId: rooms.OUT_OF_SERVICE, ...interval } },
      });
      expect(JSON.parse(String((response.content as { text: string }[])[0].text)).status).toBe(403);
    } finally {
      await readonly.client.close();
      await readonly.server.close();
    }
    const response = await client.callTool({
      name: "add_equipment_allocation",
      arguments: { eventId: "missing", input: { equipmentId: equipment.FAULTY, ...interval } },
    });
    expect(JSON.parse(String((response.content as { text: string }[])[0].text)).status).toBe(404);
  });
});
