import { afterAll, beforeAll, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { db } from "~/lib/db.server";
import { registerRoundTools } from "~/lib/mcp/round-tools.server";
import type { McpContext } from "~/lib/mcp/types.server";

const sessions: { server: McpServer; client: Client }[] = [];
const userIds: string[] = [];
let roomId: string;
let roundId: string;
let ownFunctionId: string;
let member: McpContext;
let admin: McpContext;
beforeAll(async () => {
  for (const role of ["MEMBER", "ADMIN"] as const) {
    const user = await db.user.create({
      data: {
        name: `Synthetic round ${role}`,
        email: `round-${crypto.randomUUID()}@example.test`,
        role,
      },
    });
    userIds.push(user.id);
    const context: McpContext = {
      user: { ...user, initials: null },
      token: { id: "synthetic-token", name: "Synthetic round token", scope: "READ_WRITE" },
    };
    if (role === "MEMBER") member = context;
    else admin = context;
  }
  const room = await db.room.create({
    data: { name: "Synthetic MCP round room", slug: `mcp-round-${crypto.randomUUID()}` },
  });
  roomId = room.id;
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  ownFunctionId = (
    await db.roomFunction.create({
      data: {
        name: "Synthetic own function",
        position: 999,
        kinds: { create: { kindId: kind.id, role: "CARRIER" } },
      },
    })
  ).id;
  await db.equipment.create({ data: { roomId, kindId: kind.id, category: "PROJECTOR" } });
});
afterAll(async () => {
  for (const session of sessions) {
    await session.client.close();
    await session.server.close();
  }
  await db.roomCheck.deleteMany({ where: { roomId } });
  await db.functionOverride.deleteMany({ where: { roomId } });
  if (roundId) await db.round.delete({ where: { id: roundId } });
  await db.ticket.deleteMany({ where: { roomId } });
  await db.equipment.deleteMany({ where: { roomId } });
  await db.roomFunction.delete({ where: { id: ownFunctionId } });
  await db.room.delete({ where: { id: roomId } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
});
async function connect(context: McpContext) {
  const server = new McpServer({ name: "round-test", version: "1" });
  registerRoundTools(server, context);
  const client = new Client({ name: "round-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  sessions.push({ server, client });
  return client;
}

it("publishes five tools and enforces scope and role before mutation", async () => {
  const reader = await connect({ ...member, token: { ...member.token, scope: "READ_ONLY" } });
  const tools = (await reader.listTools()).tools;
  expect(tools).toHaveLength(5);
  expect(tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name)).toEqual([
    "get_round",
  ]);
  const refused = await reader.callTool({
    name: "start_round",
    arguments: { name: "Synthetic round", roomIds: [roomId] },
  });
  expect(refused.isError).toBe(true);
  expect(refused.content).toEqual([
    expect.objectContaining({ text: expect.stringContaining('"status":403') }),
  ]);
  const writer = await connect(member);
  const denied = await writer.callTool({
    name: "set_function_state",
    arguments: { roomId, functionKey: "picture", state: "DOWN", reason: "Synthetic reason" },
  });
  expect(denied.isError).toBe(true);
});

it("starts and reads progress, records an own function and sets and clears an audited state", async () => {
  const writer = await connect(admin);
  const started = await writer.callTool({
    name: "start_round",
    arguments: { name: "Synthetic MCP round", roomIds: [roomId] },
  });
  expect(started.isError).not.toBe(true);
  roundId = String((started.structuredContent as { result: { id: string } }).result.id);
  const checked = await writer.callTool({
    name: "record_check",
    arguments: { roomId, functionKey: ownFunctionId, result: "LIMITED", roundId },
  });
  expect(checked.isError).not.toBe(true);
  const progress = await writer.callTool({ name: "get_round", arguments: { id: roundId } });
  expect(progress.structuredContent).toMatchObject({
    result: { done: 0, faults: [expect.objectContaining({ status: "OPEN" })] },
  });
  for (const name of ["set_function_state", "clear_function_state"]) {
    const result = await writer.callTool({
      name,
      arguments: {
        roomId,
        functionKey: ownFunctionId,
        state: "WORKS",
        reason: "Synthetic admin reason",
      },
    });
    expect(result.isError).not.toBe(true);
  }
  expect(
    await db.activityLog.count({
      where: { entityId: roomId, action: "FunctionStateSet", actorId: admin.user.id },
    }),
  ).toBe(1);
});
