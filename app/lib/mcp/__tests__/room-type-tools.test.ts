import { afterAll, beforeAll, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { db } from "~/lib/db.server";
import { registerRoomTypeTools } from "../room-type-tools.server";
import type { McpContext } from "../types.server";

let context: McpContext;
let roomId: string;
let typeId: string;
let functionId: string;
const sessions: { server: McpServer; client: Client }[] = [];
beforeAll(async () => {
  const user = await db.user.create({
    data: {
      name: "Synthetic type member",
      email: `type-${crypto.randomUUID()}@example.test`,
      role: "MEMBER",
    },
  });
  context = {
    user: { ...user, initials: null },
    token: { id: "synthetic-token", name: "Synthetic type token", scope: "READ_WRITE" },
  };
  roomId = (
    await db.room.create({
      data: { name: "Synthetic MCP type room", slug: `mcp-type-${crypto.randomUUID()}` },
    })
  ).id;
  functionId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } })).id;
  typeId = (
    await db.roomType.create({
      data: {
        name: "Synthetic custom room type",
        position: 999,
        functions: { create: { functionId } },
      },
    })
  ).id;
});
afterAll(async () => {
  for (const { client, server } of sessions) {
    await client.close();
    await server.close();
  }
  await db.room.delete({ where: { id: roomId } });
  await db.roomType.delete({ where: { id: typeId } });
  await db.user.delete({ where: { id: context.user.id } });
  await db.$disconnect();
});
async function connect(scope: "READ_ONLY" | "READ_WRITE") {
  const server = new McpServer({ name: "room-types-test", version: "1" });
  registerRoomTypeTools(server, { ...context, token: { ...context.token, scope } });
  const client = new Client({ name: "room-types-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  sessions.push({ server, client });
  return client;
}
it("allows read-only type discovery but refuses both writes", async () => {
  const client = await connect("READ_ONLY");
  expect((await client.callTool({ name: "list_room_types", arguments: {} })).isError).not.toBe(
    true,
  );
  for (const [name, args] of [
    ["set_room_type", { roomId, type: typeId }],
    ["set_function_expected", { roomId, functionKey: "picture", expected: false }],
  ] as const) {
    expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
  }
  expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).roomTypeId).toBeNull();
});
it("lets members assign an own type, adjust and restore expectations through the audited writer", async () => {
  const client = await connect("READ_WRITE");
  expect(
    (await client.callTool({ name: "set_room_type", arguments: { roomId, type: typeId } })).isError,
  ).not.toBe(true);
  expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).hasProjector).toBe(true);
  for (const expected of [false, null]) {
    expect(
      (
        await client.callTool({
          name: "set_function_expected",
          arguments: { roomId, functionKey: functionId, expected, note: "Synthetic adjustment" },
        })
      ).isError,
    ).not.toBe(true);
    expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).hasProjector).toBe(
      expected === null,
    );
  }
  const audit = await db.activityLog.findFirstOrThrow({
    where: { entityId: roomId, action: "RoomExpectationsChanged" },
  });
  expect(audit.actorId).toBe(context.user.id);
  expect(audit.actorSnapshot).toMatchObject({ tokenId: context.token.id });
});
