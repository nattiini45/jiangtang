import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { db } from "~/lib/db.server";
import { initializeEquipmentKinds, listDeviceKinds } from "~/lib/equipment-kinds/kinds.server";
import { DEFAULT_EQUIPMENT_KINDS } from "~/lib/equipment-kinds/defaults";
import { createEquipment, updateEquipment } from "~/domains/inventory/inventory.mutations.server";
import { createModel, updateModel } from "~/domains/catalog/catalog.mutations.server";
import { registerStructureTools } from "~/lib/mcp/structure-tools.server";
import { registerPlaceWrites } from "~/lib/mcp/place-writes.server";
import { registerReadTools } from "~/lib/mcp/read-tools.server";
import { reindexSource, drainReindexJobs } from "~/lib/search/indexer.server";
import {
  createDeviceKind,
  createFunctionGroup,
  deleteStructureEntry,
  updateDeviceKind,
  updateFunctionGroup,
  KIND_LIMIT,
  GROUP_LIMIT,
} from "../structure.server";

const prefix = `struct-${randomUUID().slice(0, 8)}-`;
const actor = { name: "Synthetic structure admin" };
beforeAll(initializeEquipmentKinds);
afterEach(async () => {
  const kinds = await db.equipmentKind.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  const devices = await db.equipment.findMany({
    where: { name: { startsWith: prefix } },
    select: { id: true },
  });
  await db.chunk.deleteMany({ where: { sourceId: { in: devices.map((row) => row.id) } } });
  await db.searchIndexJob.deleteMany({ where: { sourceId: { in: devices.map((row) => row.id) } } });
  await db.equipment.deleteMany({ where: { name: { startsWith: prefix } } });
  await db.equipmentModel.deleteMany({ where: { name: { startsWith: prefix } } });
  await db.equipmentKind.deleteMany({ where: { id: { in: kinds.map((row) => row.id) } } });
  await db.equipmentFunctionGroup.deleteMany({ where: { name: { startsWith: prefix } } });
});
afterAll(() => db.$disconnect());
async function fixture() {
  const group = await createFunctionGroup(actor, { name: `${prefix}Group` });
  const kind = await createDeviceKind(actor, { name: `${prefix}Kind`, groupId: group.id });
  return { group, kind };
}

describe("structure rules against PostgreSQL", () => {
  it("keeps field applicability on archive and names every field that blocks deletion", async () => {
    const { group, kind } = await fixture();
    const target = await createDeviceKind(actor, { name: `${prefix}Target`, groupId: group.id });
    const field = await db.customField.create({
      data: {
        scope: "EQUIPMENT",
        key: `structure_${randomUUID().slice(0, 8)}`,
        name: `${prefix}Lens`,
        type: "TEXT",
        kinds: { create: { kindId: kind.id } },
      },
    });
    try {
      await createEquipment(actor, {
        name: `${prefix}Device`,
        kindId: kind.id,
        mobility: "POOLED",
        status: "OPERATIONAL",
      });
      await updateDeviceKind(actor, kind.id, { archived: true, moveDevicesTo: target.id });
      expect(
        await db.customFieldKind.count({ where: { fieldId: field.id, kindId: kind.id } }),
      ).toBe(1);
      await expect(deleteStructureEntry(actor, "kind", kind.id)).rejects.toMatchObject({
        formErrors: [expect.stringContaining(field.name)],
      });
      expect(await db.customFieldKind.count({ where: { fieldId: field.id } })).toBe(1);
    } finally {
      await db.customField.delete({ where: { id: field.id } });
    }
    await deleteStructureEntry(actor, "kind", kind.id);
  });
  it("validates names, translates active case-insensitive conflicts and refuses occupied restores", async () => {
    const { group, kind } = await fixture();
    expect(kind.tracksFrequency).toBe(false);
    for (const name of ["", " ", "x".repeat(61)])
      await expect(createDeviceKind(actor, { name, groupId: group.id })).rejects.toThrow();
    await expect(
      createDeviceKind(actor, { name: kind.name.toUpperCase(), groupId: group.id }),
    ).rejects.toMatchObject({ fieldErrors: { name: [expect.any(String)] } });
    await expect(
      createFunctionGroup(actor, { name: group.name.toUpperCase() }),
    ).rejects.toMatchObject({ fieldErrors: { name: [expect.any(String)] } });
    await updateDeviceKind(actor, kind.id, { archived: true });
    await createDeviceKind(actor, { name: kind.name, groupId: group.id });
    await expect(updateDeviceKind(actor, kind.id, { archived: false })).rejects.toMatchObject({
      fieldErrors: { name: [expect.any(String)] },
    });
    await updateDeviceKind(actor, kind.id, { name: `${prefix}Archived renamed` });
    await updateDeviceKind(actor, kind.id, { archived: false });
  });

  it("serializes additions at the active kind and group limits, including restore", async () => {
    const { group, kind } = await fixture();
    await updateDeviceKind(actor, kind.id, { archived: true });
    const count = await db.equipmentKind.count({ where: { archivedAt: null } });
    await db.equipmentKind.createMany({
      data: Array.from({ length: KIND_LIMIT - count - 1 }, (_, i) => ({
        name: `${prefix}Limit ${i}`,
        groupId: group.id,
        position: i,
      })),
    });
    const attempts = await Promise.allSettled([
      createDeviceKind(actor, { name: `${prefix}Last A`, groupId: group.id }),
      createDeviceKind(actor, { name: `${prefix}Last B`, groupId: group.id }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    await expect(updateDeviceKind(actor, kind.id, { archived: false })).rejects.toMatchObject({
      fieldErrors: { name: [expect.stringContaining("80")] },
    });
    const archived = await createFunctionGroup(actor, { name: `${prefix}Archived group` });
    await updateFunctionGroup(actor, archived.id, { archived: true });
    const groups = await db.equipmentFunctionGroup.count({ where: { archivedAt: null } });
    await db.equipmentFunctionGroup.createMany({
      data: Array.from({ length: GROUP_LIMIT - groups }, (_, i) => ({
        name: `${prefix}Group limit ${i}`,
        position: i,
      })),
    });
    await expect(createFunctionGroup(actor, { name: `${prefix}Too many` })).rejects.toMatchObject({
      fieldErrors: { name: [expect.stringContaining("30")] },
    });
    await expect(updateFunctionGroup(actor, archived.id, { archived: false })).rejects.toThrow();
  });

  it("protects every legacy kind while allowing names and groups to change", async () => {
    for (const definition of Object.values(DEFAULT_EQUIPMENT_KINDS)) {
      const kind = await db.equipmentKind.findUniqueOrThrow({
        where: { systemKey: definition.key },
      });
      await expect(updateDeviceKind(actor, kind.id, { archived: true })).rejects.toThrow();
      await expect(deleteStructureEntry(actor, "kind", kind.id)).rejects.toThrow();
    }
    const { group } = await fixture();
    const projector = await db.equipmentKind.findUniqueOrThrow({
      where: { systemKey: "projector" },
    });
    try {
      await updateDeviceKind(actor, projector.id, {
        name: `${prefix}Projection`,
        groupId: group.id,
      });
      expect(
        await db.equipmentKind.findUniqueOrThrow({ where: { id: projector.id } }),
      ).toMatchObject({ name: `${prefix}Projection`, groupId: group.id });
    } finally {
      await updateDeviceKind(actor, projector.id, {
        name: projector.name,
        groupId: projector.groupId,
      });
    }
  });

  it("reorders kinds within a group, regroups them and reorders groups", async () => {
    const { group, kind } = await fixture();
    const second = await createDeviceKind(actor, { name: `${prefix}Second`, groupId: group.id });
    expect((await updateDeviceKind(actor, second.id, { position: 0 })).position).toBe(0);
    expect(
      (await listDeviceKinds()).find((row) => row.id === group.id)?.kinds.map((row) => row.id),
    ).toEqual([second.id, kind.id]);
    const next = await createFunctionGroup(actor, { name: `${prefix}Next` });
    await updateDeviceKind(actor, second.id, { groupId: next.id });
    expect((await updateFunctionGroup(actor, next.id, { position: 0 })).position).toBe(0);
    expect((await listDeviceKinds())[0].id).toBe(next.id);
    expect((await listDeviceKinds())[0].kinds[0].id).toBe(second.id);
  });

  it("moves devices and models atomically, audits each one and refreshes derived search text", async () => {
    const { group, kind } = await fixture();
    const target = await createDeviceKind(actor, { name: `${prefix}Target`, groupId: group.id });
    const device = await createEquipment(actor, {
      name: `${prefix}Device`,
      kindId: kind.id,
      mobility: "POOLED",
      status: "OPERATIONAL",
    });
    const model = await createModel(actor, { name: `${prefix}Model`, kindId: kind.id });
    await reindexSource("EQUIPMENT", device.id);
    await expect(updateDeviceKind(actor, kind.id, { archived: true })).rejects.toThrow();
    await expect(
      updateDeviceKind(actor, kind.id, { archived: true, moveDevicesTo: kind.id }),
    ).rejects.toThrow();
    expect((await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).kindId).toBe(
      kind.id,
    );
    await updateDeviceKind(actor, kind.id, { archived: true, moveDevicesTo: target.id });
    expect((await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).kindId).toBe(
      target.id,
    );
    expect((await db.equipmentModel.findUniqueOrThrow({ where: { id: model.id } })).kindId).toBe(
      target.id,
    );
    const logs = await db.activityLog.findMany({
      where: { entityId: { in: [device.id, model.id, kind.id] } },
    });
    expect(logs.find((log) => log.action === "EquipmentKindArchived")?.data).toMatchObject({
      deviceCount: 1,
      modelCount: 1,
    });
    for (const id of [device.id, model.id])
      expect(
        logs.some((log) => log.entityId === id && JSON.stringify(log.data).includes(target.name)),
      ).toBe(true);
    await drainReindexJobs();
    expect(
      (await db.chunk.findMany({ where: { sourceId: device.id } })).some((chunk) =>
        chunk.text.includes(target.name),
      ),
    ).toBe(true);
    await updateDeviceKind(actor, target.id, { name: `${prefix}New label` });
    await updateFunctionGroup(actor, group.id, { name: `${prefix}New function` });
    await drainReindexJobs();
    const text = (await db.chunk.findMany({ where: { sourceId: device.id } }))
      .map((chunk) => chunk.text)
      .join(" ");
    expect(text).toContain(`${prefix}New label`);
    expect(text).toContain(`${prefix}New function`);
    await deleteStructureEntry(actor, "kind", kind.id);
    expect(await db.equipmentKind.findUnique({ where: { id: kind.id } })).toBeNull();
  });

  it("refuses group archive with active kinds and deletion with any remaining reference", async () => {
    const { group, kind } = await fixture();
    await expect(updateFunctionGroup(actor, group.id, { archived: true })).rejects.toThrow();
    await expect(deleteStructureEntry(actor, "kind", kind.id)).rejects.toThrow();
    await updateDeviceKind(actor, kind.id, { archived: true });
    await updateFunctionGroup(actor, group.id, { archived: true });
    await expect(deleteStructureEntry(actor, "group", group.id)).rejects.toThrow();
    await expect(updateDeviceKind(actor, kind.id, { archived: false })).rejects.toThrow();
    await deleteStructureEntry(actor, "kind", kind.id);
    await deleteStructureEntry(actor, "group", group.id);
  });

  it("refuses archived selections on device/model writes but preserves an existing selection", async () => {
    const { group, kind } = await fixture();
    const device = await createEquipment(actor, {
      name: `${prefix}Device`,
      kindId: kind.id,
      mobility: "POOLED",
      status: "OPERATIONAL",
    });
    const model = await createModel(actor, { name: `${prefix}Model`, kindId: kind.id });
    await db.equipmentKind.update({ where: { id: kind.id }, data: { archivedAt: new Date() } });
    await expect(
      createEquipment(actor, {
        name: `${prefix}New`,
        kindId: kind.id,
        mobility: "POOLED",
        status: "OPERATIONAL",
      }),
    ).rejects.toThrow();
    await expect(
      createModel(actor, { name: `${prefix}New model`, kindId: kind.id }),
    ).rejects.toThrow();
    await updateEquipment(actor, device.id, {
      name: device.name!,
      kindId: kind.id,
      mobility: "POOLED",
      status: "OPERATIONAL",
    });
    await updateModel(actor, model.id, { name: model.name, kindId: kind.id });
    await db.equipmentKind.update({ where: { id: kind.id }, data: { archivedAt: null } });
    await db.equipmentFunctionGroup.update({
      where: { id: group.id },
      data: { archivedAt: new Date() },
    });
    await expect(
      createModel(actor, { name: `${prefix}Another model`, kindId: kind.id }),
    ).rejects.toThrow();
  });
});

it("exposes admin definition tools through the real MCP SDK, with write kinds and counts", async () => {
  const server = new McpServer({ name: "structure-test", version: "1" });
  const context = {
    user: {
      id: "synthetic",
      name: "Synthetic",
      email: "test@example.invalid",
      initials: null,
      role: "ADMIN" as const,
    },
    token: { id: "synthetic", name: "Synthetic", scope: "READ_WRITE" as const },
  };
  const user = await db.user.findFirstOrThrow();
  context.user.id = user.id;
  registerStructureTools(server, context);
  registerPlaceWrites(server, context);
  registerReadTools(server, context);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  async function call(name: string, args: Record<string, unknown>) {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    return (response.structuredContent as { result: Record<string, unknown> }).result;
  }
  try {
    const group = await call("create_function_group", { name: `${prefix}SDK group` });
    await call("update_function_group", {
      id: group.id,
      name: `${prefix}SDK renamed`,
      position: 0,
    });
    const kind = await call("create_device_kind", { name: `${prefix}SDK kind`, groupId: group.id });
    await call("update_device_kind", {
      id: kind.id,
      name: `${prefix}SDK renamed kind`,
      position: 0,
    });
    const device = await call("create_equipment", {
      name: `${prefix}SDK device`,
      kindId: kind.id,
      mobility: "POOLED",
    });
    expect(device.kind).toMatchObject({
      id: kind.id,
      name: `${prefix}SDK renamed kind`,
      group: { id: group.id },
    });
    const model = await call("create_equipment_model", {
      name: `${prefix}SDK model`,
      kindId: kind.id,
    });
    expect(model.kind).toMatchObject({ id: kind.id });
    const kinds = await client.callTool({
      name: "list_device_kinds",
      arguments: { includeArchived: true },
    });
    expect(JSON.stringify(kinds.structuredContent)).toContain('"deviceCount":1');
    context.user.role = "MEMBER" as "ADMIN";
    expect(
      (
        await client.callTool({
          name: "create_function_group",
          arguments: { name: `${prefix}Denied` },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
