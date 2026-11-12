import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { db } from "~/lib/db.server";
import { initializeEquipmentKinds } from "~/lib/equipment-kinds/kinds.server";
import { reconcileLibrary } from "~/lib/custom-fields/library.server";
import { registerCatalogTools } from "../catalog-tools.server";
import { registerReadTools } from "../read-tools.server";

it("searches, links and unlinks through MCP with scope and admin enforcement", async () => {
  await initializeEquipmentKinds();
  await reconcileLibrary();
  const user = await db.user.create({
    data: {
      name: "Synthetic catalog client",
      role: "ADMIN",
      email: `${randomUUID()}@example.test`,
    },
  });
  const connections: { client: Client; server: McpServer }[] = [];
  const open = async (role: "ADMIN" | "MEMBER", scope: "READ_WRITE" | "READ_ONLY") => {
    const server = new McpServer({ name: "synthetic", version: "1" });
    registerCatalogTools(server, {
      user: { ...user, role },
      token: { id: "synthetic-catalog-token", name: "Synthetic catalog", scope },
    });
    registerReadTools(server, {
      user: { ...user, role },
      token: { id: "synthetic-catalog-token", name: "Synthetic catalog", scope },
    });
    const client = new Client({ name: "synthetic", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    connections.push({ server, client });
    return client;
  };
  let modelId: string | undefined;
  try {
    const reader = await open("ADMIN", "READ_ONLY");
    const search = await reader.callTool({
      name: "list_model_catalog",
      arguments: { query: "V11H892040", kind: "projector" },
    });
    expect(search.isError).not.toBe(true);
    expect(search.structuredContent).toMatchObject({
      result: [expect.objectContaining({ key: "epson-eb-l1750u" })],
    });
    expect(
      (
        await reader.callTool({
          name: "link_catalog_model",
          arguments: { catalogKey: "epson-eb-l1750u" },
        })
      ).isError,
    ).toBe(true);
    const writer = await open("MEMBER", "READ_WRITE");
    const result = await writer.callTool({
      name: "link_catalog_model",
      arguments: { catalogKey: "epson-eb-l1750u" },
    });
    expect(result.isError).not.toBe(true);
    modelId = (result.structuredContent as { result: { id: string } }).result.id;
    const detail = await writer.callTool({
      name: "get_equipment_model",
      arguments: { id: modelId },
    });
    expect(detail.structuredContent).toMatchObject({
      result: {
        catalogKey: "epson-eb-l1750u",
        catalogSource: { manufacturer: "Epson", retrievedOn: "2026-11-12" },
      },
    });
    expect((detail.structuredContent as { result: object }).result).not.toHaveProperty(
      "catalogSnapshot",
    );
    expect(
      (await writer.callTool({ name: "unlink_catalog_model", arguments: { modelId } })).isError,
    ).toBe(true);
    const admin = await open("ADMIN", "READ_WRITE");
    expect(
      (await admin.callTool({ name: "unlink_catalog_model", arguments: { modelId } })).isError,
    ).not.toBe(true);
    expect(await db.equipmentModel.findUnique({ where: { id: modelId } })).toMatchObject({
      catalogKey: null,
    });
    expect(
      await db.activityLog.findFirst({
        where: { entityId: modelId, action: "CatalogModelLinked" },
      }),
    ).toMatchObject({
      actorSnapshot: expect.objectContaining({ tokenId: "synthetic-catalog-token" }),
    });
  } finally {
    for (const { client, server } of connections) {
      await client.close();
      await server.close();
    }
    if (modelId) await db.equipmentModel.delete({ where: { id: modelId } });
    await db.user.delete({ where: { id: user.id } });
  }
});
