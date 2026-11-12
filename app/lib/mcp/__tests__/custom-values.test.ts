import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "~/lib/db.server";
import { createMcpServer } from "../server.server";
import type { McpContext } from "../types.server";

const run = `fields-${randomUUID()}`;
let client: Client, server: McpServer;
let principal: McpContext;
const ids = { rooms: [] as string[], equipment: [] as string[], fields: [] as string[] };
async function connect(
  role: "ADMIN" | "MEMBER" = "ADMIN",
  scope: "READ_WRITE" | "READ_ONLY" = "READ_WRITE",
) {
  const server = createMcpServer({
    ...principal,
    user: { ...principal.user, role },
    token: { ...principal.token, scope },
  });
  const client = new Client({ name: "synthetic fields", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, server };
}
async function success(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  return (response.structuredContent as { result: Record<string, unknown> }).result;
}
beforeAll(async () => {
  const user = await db.user.create({
    data: { name: "Synthetic field admin", email: `${run}@example.test`, role: "ADMIN" },
  });
  principal = { user, token: { id: run, name: "Synthetic custom fields", scope: "READ_WRITE" } };
  ({ client, server } = await connect());
});
afterAll(async () => {
  await client.close();
  await server.close();
  await db.equipment.deleteMany({ where: { id: { in: ids.equipment } } });
  await db.room.deleteMany({ where: { id: { in: ids.rooms } } });
  await db.customField.deleteMany({ where: { id: { in: ids.fields } } });
  await db.user.delete({ where: { id: principal.user.id } });
});

describe("MCP custom value round trip", () => {
  it("defines room choices and projector hours, writes, lists, reads and preserves omitted values", async () => {
    const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
    const hours = await success("create_custom_field", {
      scope: "EQUIPMENT",
      key: "synthetic_lamp_hours",
      name: "Lampenstunden",
      type: "NUMBER",
      kindIds: [kind.id],
    });
    ids.fields.push(String(hours.id));
    const layout = await success("create_custom_field", {
      scope: "ROOM",
      key: "synthetic_layout",
      name: `${run} layout`,
      type: "CHOICE",
    });
    ids.fields.push(String(layout.id));
    await success("update_field_options", {
      fieldId: layout.id,
      changes: [
        { op: "add", label: "Standing" },
        { op: "add", label: "Seated" },
      ],
    });
    const room = await success("create_room", {
      name: run,
      customValues: { synthetic_layout: "standing" },
    });
    ids.rooms.push(String(room.id));
    const equipment = await success("create_equipment", {
      name: run,
      category: "PROJECTOR",
      mobility: "POOLED",
      customValues: { synthetic_lamp_hours: 120 },
    });
    ids.equipment.push(String(equipment.id));
    expect(room.customValues).toEqual({ synthetic_layout: "Standing" });
    expect(equipment.customValues).toEqual({ synthetic_lamp_hours: 120 });
    await success("update_room", { id: room.id, input: { name: run } });
    await success("update_equipment", {
      id: equipment.id,
      input: { category: "PROJECTOR", mobility: "POOLED", name: run },
    });
    expect((await success("get_room", { id: room.id })).customValues).toEqual({
      synthetic_layout: "Standing",
    });
    expect((await success("get_equipment", { id: equipment.id })).customValues).toEqual({
      synthetic_lamp_hours: 120,
    });
    for (const name of ["list_rooms", "list_equipment"]) {
      const result = await success(name, { q: run });
      expect(result.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ customValues: expect.any(Object) })]),
      );
    }
    const member = await connect("MEMBER");
    try {
      expect(
        (
          await member.client.callTool({
            name: "set_custom_values",
            arguments: {
              scope: "EQUIPMENT",
              id: equipment.id,
              values: { synthetic_lamp_hours: 121 },
            },
          })
        ).isError,
      ).not.toBe(true);
      for (const [name, args] of [
        ["create_custom_field", { scope: "ROOM", key: "denied", name: "Denied", type: "TEXT" }],
        ["update_custom_field", { id: layout.id, name: "Denied" }],
        ["update_field_options", { fieldId: layout.id, changes: [{ op: "add", label: "Denied" }] }],
        ["delete_custom_field", { id: layout.id, confirm: true }],
      ] as const)
        expect((await member.client.callTool({ name, arguments: args })).isError).toBe(true);
    } finally {
      await member.client.close();
      await member.server.close();
    }
    const error = await client.callTool({
      name: "set_custom_values",
      arguments: { scope: "EQUIPMENT", id: equipment.id, values: { synthetic_lamp_hours: "bad" } },
    });
    expect(error.isError).toBe(true);
    expect(JSON.parse((error.content[0] as { text: string }).text).detail.errors).toEqual([
      { field: "synthetic_lamp_hours", code: "not_a_number" },
    ]);
    expect((await success("get_equipment", { id: equipment.id })).customValues).toEqual({
      synthetic_lamp_hours: 121,
    });
    const reader = await connect("ADMIN", "READ_ONLY");
    try {
      expect(
        (
          await reader.client.callTool({
            name: "set_custom_values",
            arguments: { scope: "ROOM", id: room.id, values: {} },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await reader.client.close();
      await reader.server.close();
    }
    const audit = await db.activityLog.findMany({
      where: { entityId: String(equipment.id), action: "EquipmentUpdated" },
    });
    expect(audit.some((row) => (row.data as { custom?: unknown[] })?.custom?.length === 1)).toBe(
      true,
    );
    expect(audit.every((row) => (row.actorSnapshot as { tokenId: string }).tokenId === run)).toBe(
      true,
    );
  });

  it("accepts custom values in both bulk tools and rolls a failed row back with its batch", async () => {
    const before = await db.room.count({ where: { name: { startsWith: run } } });
    const rejected = await client.callTool({
      name: "bulk_create_rooms",
      arguments: {
        rows: [
          { name: `${run} valid`, customValues: { synthetic_layout: "Seated" } },
          { name: `${run} invalid`, customValues: { synthetic_layout: "Unknown" } },
        ],
      },
    });
    expect(rejected.isError).toBe(true);
    expect(await db.room.count({ where: { name: { startsWith: run } } })).toBe(before);
    const rooms = await success("bulk_create_rooms", {
      rows: [{ name: `${run} bulk`, customValues: { synthetic_layout: "Seated" } }],
    });
    ids.rooms.push(...(rooms.items as { id: string }[]).map((row) => row.id));
    const devices = await success("bulk_create_equipment", {
      rows: [
        {
          name: `${run} bulk`,
          kategorie: "PROJECTOR",
          mobilitaet: "POOLED",
          customValues: { synthetic_lamp_hours: 22 },
        },
      ],
    });
    ids.equipment.push(...(devices.items as { id: string }[]).map((row) => row.id));
    expect((await success("get_room", { id: ids.rooms.at(-1) })).customValues).toEqual({
      synthetic_layout: "Seated",
    });
    expect((await success("get_equipment", { id: ids.equipment.at(-1) })).customValues).toEqual({
      synthetic_lamp_hours: 22,
    });
  });

  it("accepts the supported 500-row bulk size with custom values", async () => {
    const batch = await success("bulk_create_rooms", {
      rows: Array.from({ length: 500 }, (_, index) => ({
        name: `${run} capacity ${index}`,
        customValues: { synthetic_layout: "Seated" },
      })),
    });
    ids.rooms.push(...(batch.items as { id: string }[]).map((row) => row.id));
    expect(batch.created).toBe(500);
  });

  it("uses the same labeled, active-only value projection for resources", async () => {
    const roomId = ids.rooms[0],
      equipmentId = ids.equipment[0];
    const read = async (scope: string, id: string) => {
      const response = await client.readResource({ uri: `jiangtang://${scope}/${id}` });
      return JSON.parse((response.contents[0] as { text: string }).text).result;
    };
    expect((await read("rooms", roomId)).customValues).toEqual({ synthetic_layout: "Standing" });
    expect((await read("equipment", equipmentId)).customValues).toEqual({
      synthetic_lamp_hours: 121,
    });
    await success("update_custom_field", { id: ids.fields[0], archived: true });
    expect((await read("equipment", equipmentId)).customValues).toEqual({});
    await success("update_custom_field", { id: ids.fields[0], archived: false });
  });
});
