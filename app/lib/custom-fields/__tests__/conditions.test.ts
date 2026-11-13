import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { db } from "~/lib/db.server";
import { initializeEquipmentKinds } from "~/lib/equipment-kinds/kinds.server";
import { reconcileLibrary } from "../library.server";
import { getFieldSchema } from "../schema.server";
import { withFieldValues, modelFieldValues } from "../display.server";
import { conditionHolds, valueObject, fieldGroups } from "../fields";
import { getFormFields, parseFieldForm } from "../form.server";
import {
  getRecordSchema,
  updateCustomField,
  updateFieldOptions,
  deleteCustomField,
} from "../definitions.server";
import { moveCustomField } from "../admin.server";
import { unmigratedLegacyValues } from "../legacy.server";
import { setModelValues } from "~/domains/catalog/catalog.values.server";
import {
  setEquipmentCustomValues,
  clearLegacyEquipmentValue,
} from "~/domains/inventory/inventory.custom-values.server";
import {
  createEquipment,
  bulkCreateEquipment,
} from "~/domains/inventory/inventory.mutations.server";
import { equipmentCreateSchema, equipmentCsvRowSchema } from "~/domains/inventory/inventory.schema";
import { registerFieldTools } from "~/lib/mcp/field-tools.server";
import { runWithLocale } from "~/i18n/request-locale.server";
import { withListValues } from "~/lib/list-columns/columns.server";

const actor = { name: "Synthetic property keeper" };
const deviceIds: string[] = [],
  modelIds: string[] = [];
beforeEach(async () => {
  await initializeEquipmentKinds();
  await db.customField.deleteMany({ where: { systemKey: { not: null } } });
  await db.libraryState.deleteMany();
  await reconcileLibrary();
});
afterEach(async () => {
  await db.equipment.deleteMany({ where: { id: { in: deviceIds.splice(0) } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: modelIds.splice(0) } } });
  await db.customField.deleteMany({ where: { systemKey: { not: null } } });
  await db.libraryState.deleteMany();
});
async function fixture() {
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  const fields = await getFieldSchema("EQUIPMENT", { kindId: kind.id });
  const light = fields.find((field) => field.libraryKey === "projector.light_source")!;
  const lampDate = fields.find((field) => field.libraryKey === "projector.lamp_change")!;
  const models = await Promise.all(
    ["lamp", "laser"].map(async (source) => {
      const model = await db.equipmentModel.create({
        data: { name: randomUUID(), kindId: kind.id, category: "PROJECTOR" },
      });
      modelIds.push(model.id);
      await setModelValues(actor, model.id, { "projector.light_source": source });
      return model;
    }),
  );
  const devices = await Promise.all(
    models.map(async (model) => {
      const device = await db.equipment.create({
        data: {
          name: randomUUID(),
          kindId: kind.id,
          modelId: model.id,
          category: "PROJECTOR",
          customValues: { [lampDate.id]: "2025-03-04" },
        },
      });
      deviceIds.push(device.id);
      return device;
    }),
  );
  return { kind, fields, light, lampDate, models, lamp: devices[0], laser: devices[1] };
}

it("uses effective values for 220 devices across ten kinds and keeps conditional values", async () => {
  const { kind, fields, light, lampDate, models, lamp, laser } = await fixture();
  const kinds = await db.equipmentKind.findMany({ orderBy: { position: "asc" }, take: 10 });
  expect(kinds).toHaveLength(10);
  const ids = Array.from({ length: 218 }, () => randomUUID());
  const others = kinds.filter((entry) => entry.id !== kind.id);
  deviceIds.push(...ids);
  await db.equipment.createMany({
    data: ids.map((id, i) => ({
      id,
      category: i < 56 ? "PROJECTOR" : "OTHER",
      kindId: i < 56 ? kind.id : others[(i - 56) % 9].id,
      modelId: i < 56 ? models[i % 2].id : null,
      customValues: i < 56 ? { [lampDate.id]: "2025-03-04" } : {},
    })),
  });
  const read = await withFieldValues("EQUIPMENT", [lamp, laser, ...ids.map((id) => ({ id }))]);
  expect(read).toHaveLength(220);
  expect(read[0].fields.some((field) => field.id === lampDate.id)).toBe(true);
  expect(read[1].fields.some((field) => field.id === lampDate.id)).toBe(false);
  for (let i = 0; i < 56; i++)
    expect(read[i + 2].fields.some((field) => field.id === lampDate.id)).toBe(i % 2 === 0);
  const list = await withListValues(
    "EQUIPMENT",
    [
      { ...lamp, kind },
      { ...laser, kind },
    ],
    [`field:${lampDate.id}`],
  );
  expect(list[0].values).toHaveProperty(lampDate.id, "2025-03-04");
  expect(list[1].values).not.toHaveProperty(lampDate.id);
  expect(
    valueObject((await db.equipment.findUniqueOrThrow({ where: { id: laser.id } })).customValues)[
      lampDate.id
    ],
  ).toBe("2025-03-04");
  await setModelValues(actor, models[1].id, { "projector.light_source": null });
  expect(
    (await withFieldValues("EQUIPMENT", [laser]))[0].fields.some(
      (field) => field.id === lampDate.id,
    ),
  ).toBe(true);
  expect(
    conditionHolds(lampDate, fields, {
      [light.id]: light.options.find((option) => option.systemKey === "laser")!.id,
    }),
  ).toBe(false);
  expect(conditionHolds(lampDate, fields, {})).toBe(true);
});

it("refuses conditional changes from forms and imports atomically, names the controller and permits clearing", async () => {
  const { kind, lamp, laser, lampDate, light, models } = await fixture();
  await setEquipmentCustomValues(actor, lamp.id, { "projector.lamp_change": "2025-05-06" });
  const form = new FormData();
  form.set(`cf.${lampDate.id}`, "2025-05-06");
  const parsed = await parseFieldForm("EQUIPMENT", form, laser.customValues, kind.id);
  await expect(
    runWithLocale("en", () => setEquipmentCustomValues(actor, laser.id, parsed!)),
  ).rejects.toMatchObject({
    fieldErrors: { [lampDate.key]: [expect.stringContaining("Light source")] },
  });
  const csv = equipmentCsvRowSchema.parse({ kategorie: "PROJECTOR", mobilitaet: "POOLED" });
  const count = await db.equipment.count();
  await expect(
    bulkCreateEquipment(actor, [
      {
        ...csv,
        customValues: { "projector.light_source": "laser", "projector.lamp_change": "2025-06-07" },
      },
    ]),
  ).rejects.toMatchObject({
    fieldErrors: { [lampDate.key]: [expect.stringContaining(light.name)] },
  });
  expect(await db.equipment.count()).toBe(count);
  await expect(
    createEquipment(actor, {
      ...equipmentCreateSchema.parse({
        kindId: kind.id,
        modelId: models[1].id,
        mobility: "POOLED",
      }),
      customValues: { "projector.lamp_change": "2025-06-07" },
    }),
  ).rejects.toMatchObject({
    fieldErrors: { [lampDate.key]: [expect.stringContaining(light.name)] },
  });
  await setEquipmentCustomValues(actor, laser.id, { "projector.lamp_change": null });
  expect(
    valueObject((await db.equipment.findUniqueOrThrow({ where: { id: laser.id } })).customValues),
  ).not.toHaveProperty(lampDate.id);
  await updateCustomField(actor, { id: light.id, archived: true });
  const schema = await getRecordSchema("EQUIPMENT", undefined, laser.id);
  expect(schema.find((field) => field.id === lampDate.id)?.conditionHolds).toBe(false);
  expect((await getFormFields("EQUIPMENT")).find((field) => field.id === light.id)?.hidden).toBe(
    true,
  );
});

it("checks model conditions against the same patch and retains hidden data sheets", async () => {
  const { kind, fields, models } = await fixture();
  const conditional = fields.find(
    (field) => field.level === "MODEL" && field.appliesIf?.values.includes("lamp"),
  )!;
  const value = conditional.type === "NUMBER" ? 12 : "Synthetic lamp";
  await setModelValues(actor, models[0].id, { [conditional.key]: value });
  await expect(setModelValues(actor, models[1].id, { [conditional.key]: value })).rejects.toThrow();
  await setModelValues(actor, models[0].id, { "projector.light_source": "laser" });
  const model = await db.equipmentModel.findUniqueOrThrow({ where: { id: models[0].id } });
  expect(valueObject(model.customValues)[conditional.id]).toBe(value);
  expect(
    (await modelFieldValues({ ...model, kind })).some((field) => field.id === conditional.id),
  ).toBe(false);
  await setModelValues(actor, models[0].id, {
    "projector.light_source": "lamp",
    [conditional.key]: value,
  });
});

it("hides, renames, resets and reorders library rows without changing their definitions or losing values", async () => {
  const { kind, lamp, lampDate, fields } = await fixture();
  await updateCustomField(actor, {
    id: lampDate.id,
    name: "Synthetic maintenance",
    archived: true,
    position: 900,
  });
  await reconcileLibrary();
  expect(
    (await getFieldSchema("EQUIPMENT")).find((field) => field.id === lampDate.id),
  ).toMatchObject({ hidden: true, renamed: true, name: "Synthetic maintenance", position: 900 });
  expect(
    (await withFieldValues("EQUIPMENT", [lamp]))[0].fields.some(
      (field) => field.id === lampDate.id,
    ),
  ).toBe(false);
  await updateCustomField(actor, { id: lampDate.id, archived: false, resetName: true });
  expect(
    (await runWithLocale("en", () => getFieldSchema("EQUIPMENT"))).find(
      (field) => field.id === lampDate.id,
    ),
  ).toMatchObject({ name: "Last lamp replacement", renamed: false });
  const memory = fields.find((field) => field.libraryKey === "projector.lens_memory")!;
  const previous = fields
    .filter((field) => field.level === memory.level && field.weight === memory.weight)
    .sort((a, b) => a.position - b.position)
    .filter((field) => field.position < memory.position)
    .at(-1)!;
  await moveCustomField(actor, {
    id: memory.id,
    kindId: kind.id,
    direction: "up",
    section: false,
  });
  const reordered = await getFieldSchema("EQUIPMENT", { kindId: kind.id });
  const displayed = fieldGroups(reordered.filter((field) => field.level === memory.level)).flatMap(
    (group) => group.fields.map((field) => field.id),
  );
  expect(displayed.indexOf(memory.id)).toBeLessThan(displayed.indexOf(previous.id));
  expect(reordered.find((field) => field.id === lampDate.id)?.position).toBe(900);
  await updateCustomField(actor, { id: memory.id, name: "Lens memory / recall position" });
  expect((await getFieldSchema("EQUIPMENT")).find((field) => field.id === memory.id)?.renamed).toBe(
    false,
  );
  expect(
    (await withFieldValues("EQUIPMENT", [lamp]))[0].fields.find((field) => field.id === lampDate.id)
      ?.value,
  ).toBe("2025-03-04");
  for (const input of [
    { unit: "x" },
    { type: "TEXT" as const },
    { kindIds: [] },
    { helpText: "x" },
  ])
    await expect(updateCustomField(actor, { id: lampDate.id, ...input })).rejects.toThrow();
  await expect(
    updateFieldOptions(actor, { fieldId: lampDate.id, changes: [{ op: "add", label: "x" }] }),
  ).rejects.toThrow();
  await expect(deleteCustomField(actor, lampDate.id, true)).rejects.toThrow();
});

it("shows an unrepresentable legacy value read-only and clears only that column with audit", async () => {
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "computer" } });
  const fields = await getFieldSchema("EQUIPMENT", { kindId: kind.id });
  const code = fields.find((field) => field.libraryKey === "service_code")!;
  const device = await db.equipment.create({
    data: { category: "PC", kindId: kind.id, dellServiceTag: "x".repeat(201) },
  });
  deviceIds.push(device.id);
  expect(unmigratedLegacyValues(fields, device, kind.id)).toEqual([
    expect.objectContaining({
      id: code.id,
      legacyColumn: "dellServiceTag",
      value: "x".repeat(201),
    }),
  ]);
  await expect(clearLegacyEquipmentValue(actor, device.id, "serial")).rejects.toThrow();
  await clearLegacyEquipmentValue(actor, device.id, "dellServiceTag");
  expect(
    (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).dellServiceTag,
  ).toBeNull();
  const log = await db.activityLog.findFirst({
    where: {
      entityId: device.id,
      data: { path: ["clearedLegacyColumn"], equals: "dellServiceTag" },
    },
  });
  expect(log?.data).toMatchObject({ custom: [{ from: "x".repeat(201), to: null }] });
});

it("exposes conditions and library controls through MCP and denies member configuration", async () => {
  const { laser, lampDate } = await fixture();
  const user = await db.user.create({
    data: { name: "Synthetic keeper", email: `${randomUUID()}@example.test`, role: "ADMIN" },
  });
  const server = new McpServer({ name: "synthetic", version: "1" });
  const context = {
    user,
    token: { id: "synthetic", name: "Synthetic", scope: "READ_WRITE" as const },
  };
  registerFieldTools(server, context);
  const client = new Client({ name: "synthetic", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const schema = await client.callTool({
      name: "get_record_schema",
      arguments: { scope: "EQUIPMENT", deviceId: laser.id },
    });
    expect(JSON.stringify(schema.structuredContent)).toContain('"conditionHolds":false');
    expect(JSON.stringify(schema.structuredContent)).toContain(
      '"property":"projector.light_source"',
    );
    expect(
      (
        await client.callTool({
          name: "set_custom_values",
          arguments: {
            scope: "EQUIPMENT",
            id: laser.id,
            values: { "projector.lamp_change": "2025-06-07" },
          },
        })
      ).isError,
    ).toBe(true);
    for (const patch of [
      { name: "Synthetic lamp date" },
      { resetName: true },
      { position: 800 },
      { archived: true },
      { archived: false },
    ])
      expect(
        (
          await client.callTool({
            name: "update_custom_field",
            arguments: { id: lampDate.id, ...patch },
          })
        ).isError,
      ).not.toBe(true);
    context.user.role = "MEMBER";
    expect(
      (
        await client.callTool({
          name: "update_custom_field",
          arguments: { id: lampDate.id, archived: true },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await db.user.delete({ where: { id: user.id } });
  }
});
