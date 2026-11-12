import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerPlaceWrites } from "~/lib/mcp/place-writes.server";
import { registerReadTools } from "~/lib/mcp/read-tools.server";
import type { McpContext } from "~/lib/mcp/types.server";
import { db } from "~/lib/db.server";
import { cloneRoom, markRoomChecked } from "~/domains/rooms/rooms.mutations.server";
import { roomCloneSchema } from "~/domains/rooms/rooms.schema";
import { getRoomDashboard } from "~/domains/rooms/rooms.dashboard.server";
import { loadSource } from "~/lib/search/sources.server";

const run = `knowledge_${crypto.randomUUID()}`;
const checked = "2042-06-15T10:00:00+02:00";
const context: McpContext = {
  user: { id: "", name: run, email: `${run}@example.test`, initials: null, role: "ADMIN" },
  token: { id: `${run}_token`, name: "Synthetic room checks", scope: "READ_WRITE" },
};
let client: Client;
let server: McpServer;

beforeAll(async () => {
  context.user.id = (await db.user.create({ data: { email: context.user.email, name: run } })).id;
  server = new McpServer({ name: "room-knowledge", version: "1" });
  registerPlaceWrites(server, context);
  registerReadTools(server, context);
  client = new Client({ name: "room-knowledge", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
});

afterAll(async () => {
  vi.useRealTimers();
  await client?.close();
  await server?.close();
  await db.equipment.deleteMany({ where: { room: { name: { startsWith: run } } } });
  await db.room.deleteMany({ where: { name: { startsWith: run } } });
  await db.user.deleteMany({ where: { id: context.user.id } });
  await db.$disconnect();
});

async function result(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError).not.toBe(true);
  return (response.structuredContent as { result: Record<string, unknown> }).result;
}

describe("room knowledge", () => {
  it("round-trips notes and check instants through create, update, bulk and list reads", async () => {
    const room = await result("create_room", {
      name: `${run} Hall`,
      knownIssues: `${run} loose HDMI\nUse input two`,
      lastCheckedAt: checked,
    });
    expect(room).toMatchObject({
      knownIssues: `${run} loose HDMI\nUse input two`,
      lastCheckedAt: { iso: "2042-06-15T08:00:00.000Z" },
    });
    const detail = await result("get_room", { id: room.id });
    expect(detail).toMatchObject({
      knownIssues: room.knownIssues,
      lastCheckedAt: room.lastCheckedAt,
    });
    const list = await result("list_rooms", { q: "loose HDMI" });
    expect(list.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: room.id,
          knownIssues: room.knownIssues,
          lastCheckedAt: room.lastCheckedAt,
        }),
      ]),
    );
    const source = await loadSource("ROOM", String(room.id));
    expect(source?.sections.map((section) => section.text).join("\n")).toContain("Use input two");
    const update = await result("update_room", {
      id: room.id,
      input: {
        name: `${run} Hall`,
        knownIssues: "Synthetic repair pending",
        lastCheckedAt: checked,
      },
    });
    expect(update.knownIssues).toBe("Synthetic repair pending");
    const bulk = await result("bulk_create_rooms", {
      rows: [{ name: `${run} Bulk`, knownIssues: "Synthetic crackle", lastCheckedAt: checked }],
    });
    expect(bulk.created).toBe(1);
    expect(await db.room.findFirst({ where: { name: `${run} Bulk` } })).toMatchObject({
      knownIssues: "Synthetic crackle",
      lastCheckedAt: new Date(checked),
    });
    const cleared = await result("update_room", { id: room.id, input: { name: `${run} Hall` } });
    expect(cleared).toMatchObject({ knownIssues: null, lastCheckedAt: null });
  });

  it.each(["create_room", "update_room", "bulk_create_rooms"])(
    "rejects offset-free check instants in %s",
    async (name) => {
      const input = { name: `${run} Invalid`, lastCheckedAt: "2042-06-15T10:00" };
      const args =
        name === "bulk_create_rooms"
          ? { rows: [input] }
          : name === "update_room"
            ? { id: "missing", input }
            : input;
      expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
    },
  );

  it("does not clone problems or check dates, and checks a room with an audited mutation", async () => {
    const room = await db.room.create({
      data: {
        name: `${run} Source`,
        slug: `${run}-source`,
        knownIssues: "Synthetic flicker",
        tipsNotes: "Synthetic workaround",
        lastCheckedAt: new Date(checked),
      },
    });
    const actor = { id: context.user.id, name: run, initials: null };
    const clone = await cloneRoom(
      actor,
      room.slug,
      roomCloneSchema.parse({ name: `${run} Clone`, copyTips: true }),
    );
    expect(clone).toMatchObject({
      knownIssues: null,
      lastCheckedAt: null,
      tipsNotes: "Synthetic workaround",
    });
    const now = new Date("2042-07-01T09:30:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    try {
      expect((await markRoomChecked(actor, room.id)).lastCheckedAt).toEqual(now);
    } finally {
      vi.useRealTimers();
    }
    expect(
      await db.activityLog.findFirst({ where: { entityId: room.id, action: "RoomChecked" } }),
    ).toMatchObject({ data: { lastCheckedAt: now.toISOString() } });
    await db.equipment.create({
      data: {
        roomId: room.id,
        category: "PC",
        name: "Synthetic PC",
        hostname: "demo-pc",
        ipAddress: "192.0.2.10",
        macAddress: "02:00:00:00:00:10",
        dellServiceTag: "DEMO123",
        dellExpressTag: "123456",
        serial: "DEMO-SERIAL",
        assetTag: "DEMO-ASSET",
      },
    });
    expect((await getRoomDashboard(room.slug))?.equipment[0]).toMatchObject({
      hostname: "demo-pc",
      ipAddress: "192.0.2.10",
      macAddress: "02:00:00:00:00:10",
      dellServiceTag: "DEMO123",
      dellExpressTag: "123456",
      serial: "DEMO-SERIAL",
      assetTag: "DEMO-ASSET",
    });
  });
});
