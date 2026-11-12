import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { db } from "~/lib/db.server";
import { reconcileLibrary } from "~/lib/custom-fields/library.server";
import { registerFieldTools } from "../field-tools.server";
import { registerReadTools } from "../read-tools.server";
import type { McpContext } from "../types.server";

it("exposes resolved schemas, model reads and validated model writes through MCP", async () => {
  await reconcileLibrary();
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  const user = await db.user.create({
    data: {
      name: "Synthetic property keeper",
      email: `${randomUUID()}@example.test`,
      role: "ADMIN",
    },
  });
  const model = await db.equipmentModel.create({
    data: { category: "PROJECTOR", kindId: kind.id, name: randomUUID() },
  });
  const device = await db.equipment.create({
    data: { category: "PROJECTOR", kindId: kind.id, modelId: model.id },
  });
  const server = new McpServer({ name: "synthetic", version: "1" });
  const context: McpContext = {
    user,
    token: { id: "synthetic-token", name: "Synthetic", scope: "READ_WRITE" },
  };
  registerFieldTools(server, context);
  registerReadTools(server, context);
  const client = new Client({ name: "synthetic", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const response = await client.callTool({
      name: "get_record_schema",
      arguments: { scope: "EQUIPMENT", kindId: kind.id },
    });
    const fields = (
      response.structuredContent as {
        result: { id: string; libraryKey: string; options: { id: string; key: string }[] }[];
      }
    ).result;
    const light = fields.find((field) => field.libraryKey === "projector.light_source")!;
    expect(light).toMatchObject({
      origin: "library",
      level: "MODEL",
      weight: "must",
      unit: null,
      options: expect.arrayContaining([expect.objectContaining({ key: "laser" })]),
    });
    const write = await client.callTool({
      name: "set_model_values",
      arguments: { modelId: model.id, values: { "projector.light_source": "laser" } },
    });
    expect(write.isError).not.toBe(true);
    const read = await client.callTool({
      name: "get_equipment_model",
      arguments: { id: model.id },
    });
    expect(read.isError).not.toBe(true);
    expect(JSON.stringify(read.structuredContent)).toContain(
      light.options.find((option) => option.key === "laser")!.id,
    );
    const refusal = await client.callTool({
      name: "set_custom_values",
      arguments: {
        scope: "EQUIPMENT",
        id: device.id,
        values: { "projector.light_source": "lamp" },
      },
    });
    expect(refusal.isError).toBe(true);
    expect(JSON.stringify(refusal.content)).toContain(`/inventory/models/${model.id}`);
    const create = await client.callTool({
      name: "create_custom_field",
      arguments: {
        scope: "EQUIPMENT",
        key: "synthetic_reserved",
        name: "Synthetic",
        type: "TEXT",
        systemKey: "projector.synthetic",
      },
    });
    expect(create.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await db.equipment.delete({ where: { id: device.id } });
    await db.equipmentModel.delete({ where: { id: model.id } });
    await db.user.delete({ where: { id: user.id } });
    await db.customField.deleteMany({ where: { systemKey: { not: null } } });
    await db.libraryState.deleteMany();
  }
});
