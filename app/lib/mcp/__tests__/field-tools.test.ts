import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { db } from "~/lib/db.server";
import { registerFieldTools } from "../field-tools.server";
import type { McpContext } from "../types.server";

async function fieldClient(
  role: "ADMIN" | "MEMBER" = "ADMIN",
  scope: "READ_WRITE" | "READ_ONLY" = "READ_WRITE",
) {
  const user = await db.user.create({
    data: { name: "Synthetic admin", email: `${randomUUID()}@example.test`, role: "ADMIN" },
  });
  const context: McpContext = {
    user: { ...user, role },
    token: { id: "synthetic-token", name: "Synthetic test", scope },
  };
  const server = new McpServer({ name: "synthetic", version: "1" });
  registerFieldTools(server, context);
  const client = new Client({ name: "synthetic", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, server };
}

describe("custom field MCP tools", () => {
  it("returns the name holder and its coverage through the transport", async () => {
    const { client, server } = await fieldClient();
    const name = randomUUID();
    try {
      const kind = await db.equipmentKind.findFirstOrThrow({ where: { archivedAt: null } });
      const response = await client.callTool({
        name: "create_custom_field",
        arguments: {
          scope: "EQUIPMENT",
          key: `f_${name.replaceAll("-", "")}`,
          name,
          type: "TEXT",
          kindIds: [kind.id],
        },
      });
      const field = (response.structuredContent as { result: { id: string } }).result;
      const refusal = await client.callTool({
        name: "create_custom_field",
        arguments: {
          scope: "EQUIPMENT",
          key: `g_${name.replaceAll("-", "")}`,
          name: name.toUpperCase(),
          type: "TEXT",
          kindIds: [kind.id],
        },
      });
      expect(refusal.isError).toBe(true);
      expect(JSON.stringify(refusal.content)).toContain(field.id);
      expect(JSON.stringify(refusal.content)).toContain(kind.name);
    } finally {
      await db.customField.deleteMany({ where: { name } });
      await client.close();
      await server.close();
    }
  });

  it("runs definitions through the real transport and records token attribution", async () => {
    const { client, server } = await fieldClient();
    try {
      const name = randomUUID();
      const response = await client.callTool({
        name: "create_custom_field",
        arguments: { scope: "ROOM", key: `f_${name.replaceAll("-", "")}`, name, type: "CHOICE" },
      });
      expect(response.isError).not.toBe(true);
      const field = (response.structuredContent as { result: { id: string } }).result;
      expect(
        (
          await client.callTool({
            name: "update_field_options",
            arguments: { fieldId: field.id, changes: [{ op: "add", label: "Standing" }] },
          })
        ).isError,
      ).not.toBe(true);
      expect(
        JSON.stringify(
          (await client.callTool({ name: "get_record_schema", arguments: { scope: "ROOM" } }))
            .structuredContent,
        ),
      ).toContain(name);
      await client.callTool({
        name: "update_custom_field",
        arguments: { id: field.id, archived: true },
      });
      expect(
        (
          await client.callTool({
            name: "delete_custom_field",
            arguments: { id: field.id, confirm: true },
          })
        ).isError,
      ).not.toBe(true);
      const audit = await db.activityLog.findFirstOrThrow({
        where: { entityId: field.id, action: "CustomFieldCreated" },
      });
      expect(audit.actorSnapshot).toMatchObject({ tokenId: "synthetic-token" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    ["MEMBER", "READ_WRITE"],
    ["ADMIN", "READ_ONLY"],
  ] as const)("refuses definition writes for %s with %s token", async (role, scope) => {
    const { client, server } = await fieldClient(role, scope);
    try {
      const name = randomUUID();
      const result = await client.callTool({
        name: "create_custom_field",
        arguments: { scope: "ROOM", key: "synthetic", name, type: "TEXT" },
      });
      expect(result.isError).toBe(true);
      expect(await db.customField.count({ where: { name } })).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
