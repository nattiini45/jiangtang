import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import { initializeEquipmentKinds } from "../kinds.server";
import { propertyLibrary, libraryProperties } from "../properties";
import { reconcileLibrary } from "~/lib/custom-fields/library.server";
import { register } from "../properties.boot.server";
import { installLibraryKinds } from "../library.server";
import sources from "../library-sources.json";
import {
  createCustomField,
  deleteCustomField,
  updateCustomField,
  updateFieldOptions,
} from "~/lib/custom-fields/definitions.server";
import { getFieldSchema } from "~/lib/custom-fields/schema.server";
import { getFormFields } from "~/lib/custom-fields/form.server";
import { withFieldValues } from "~/lib/custom-fields/display.server";
import {
  setEquipmentCustomValues,
  applyEquipmentCustomValuesInTx,
} from "~/domains/inventory/inventory.custom-values.server";
import { setModelValues } from "~/domains/catalog/catalog.values.server";
import { getListColumns, withListValues } from "~/lib/list-columns/columns.server";
import { updateEquipment } from "~/domains/inventory/inventory.mutations.server";
import { equipmentCreateSchema } from "~/domains/inventory/inventory.schema";
import {
  bulkCreateEquipment,
  createEquipment,
  createEquipmentInTx,
} from "~/domains/inventory/inventory.mutations.server";
import { equipmentCsvRowSchema } from "~/domains/inventory/inventory.schema";
import { parseFieldForm } from "~/lib/custom-fields/form.server";
import { runWithLocale } from "~/i18n/request-locale.server";
import { listFrequencyBoard } from "~/domains/inventory/inventory.frequency.server";
import { berlinDateInput } from "~/lib/format-date";
import { legacyProperties } from "~/lib/custom-fields/legacy.server";
import { DEFAULT_EQUIPMENT_KINDS } from "../defaults";
import { listRecentActivity } from "~/domains/activity/activity.queries.server";
import { McpServer } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { registerFieldTools } from "~/lib/mcp/field-tools.server";
import { txWithAudit } from "~/lib/audit.server";

const actor = { name: "Synthetic property editor" };
const deviceIds: string[] = [],
  modelIds: string[] = [],
  ownIds: string[] = [];
beforeEach(async () => {
  await initializeEquipmentKinds();
  await db.customField.deleteMany({ where: { systemKey: { not: null } } });
  await db.libraryState.deleteMany();
});
afterEach(async () => {
  await db.equipment.deleteMany({ where: { id: { in: deviceIds.splice(0) } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: modelIds.splice(0) } } });
  await db.customField.deleteMany({
    where: { OR: [{ systemKey: { not: null } }, { id: { in: ownIds.splice(0) } }] },
  });
  await db.libraryState.deleteMany();
  for (const key of libraryProperties.keys())
    if (key.startsWith("synthetic.")) libraryProperties.delete(key);
  vi.restoreAllMocks();
});
const projector = () => db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
async function installedPropertyCount() {
  const kinds = await db.equipmentKind.findMany({ select: { systemKey: true } });
  return new Set(
    propertyLibrary.kinds
      .filter((kind) => kinds.some((installed) => installed.systemKey === kind.key))
      .flatMap((kind) => kind.properties ?? []),
  ).size;
}

it("materializes every shipped kind without exporting readings or relations", async () => {
  const existing = await db.equipmentKind.findMany();
  const group = await db.equipmentFunctionGroup.findFirstOrThrow();
  const added: string[] = [];
  try {
    for (const kind of propertyLibrary.kinds.filter(
      (kind) => !existing.some((row) => row.systemKey === kind.key),
    )) {
      const row = await db.equipmentKind.create({
        data: { name: randomUUID(), systemKey: kind.key, groupId: group.id, position: 100 },
      });
      added.push(row.id);
    }
    await reconcileLibrary();
    for (const kind of await db.equipmentKind.findMany({
      where: { systemKey: { in: propertyLibrary.kinds.map((kind) => kind.key) } },
    })) {
      const fields = await getFieldSchema("EQUIPMENT", { kindId: kind.id });
      expect(fields.map((field) => field.libraryKey).sort()).toEqual(
        [
          ...propertyLibrary.kinds.find((entry) => entry.key === kind.systemKey)!.properties!,
        ].sort(),
      );
    }
    const name = libraryProperties.get("projector.control_protocols")!;
    for (const key of ["matrix.control_api", "dsp.control_protocol"])
      expect(libraryProperties.get(key)).toMatchObject({ de: name.de, en: name.en });
  } finally {
    await db.customFieldKind.deleteMany({ where: { kindId: { in: added } } });
    await db.equipmentKind.deleteMany({ where: { id: { in: added } } });
  }
});

it("keeps legacy microphone inputs compatible on linked devices without allowing explicit model writes", async () => {
  await reconcileLibrary();
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "microphone" } });
  const model = await db.equipmentModel.create({
    data: { name: randomUUID(), kindId: kind.id, category: "MICROPHONE" },
  });
  modelIds.push(model.id);
  await setModelValues(actor, model.id, { "microphone.type": "wired_microphone" });
  const input = equipmentCreateSchema.parse({
    kindId: kind.id,
    modelId: model.id,
    mobility: "POOLED",
    micKind: "HANDHELD",
  });
  const device = await createEquipment(actor, input);
  deviceIds.push(device.id);
  const type = (await getFieldSchema("EQUIPMENT", { kindId: kind.id })).find(
    (field) => field.libraryKey === "microphone.type",
  )!;
  expect(device.customValues).toMatchObject({
    [type.id]: type.options.find((option) => option.systemKey === "handheld_transmitter")!.id,
  });
  const updated = await updateEquipment(actor, device.id, { ...input, micKind: "BODYPACK" });
  expect(updated.micKind).toBe("BODYPACK");
  expect(updated.customValues).toMatchObject({
    [type.id]: type.options.find((option) => option.systemKey === "bodypack_transmitter")!.id,
  });
  expect(
    (await withFieldValues("EQUIPMENT", [device]))[0].fields.find((field) => field.id === type.id),
  ).toMatchObject({ from: "model", value: "Kabelmikrofon" });
  await expect(
    setEquipmentCustomValues(actor, device.id, { "microphone.type": "gooseneck" }),
  ).rejects.toThrow();
  for (const key of [type.key, type.libraryKey!])
    await expect(
      updateEquipment(actor, device.id, {
        ...input,
        micKind: "HANDHELD",
        customValues: { [key]: "gooseneck" },
      }),
    ).rejects.toThrow();
  const copied = await txWithAudit(actor, (tx, audit) =>
    createEquipmentInTx(tx, audit, {
      ...input,
      copiedValues: updated.customValues as Record<string, string>,
    }),
  );
  deviceIds.push(copied.id);
  expect(copied.micKind).toBe("HANDHELD");
});

it("does not repost or report an unchanged range after a jsonb round trip", async () => {
  await reconcileLibrary();
  const device = await createEquipment(
    actor,
    equipmentCreateSchema.parse({
      category: "PROJECTOR",
      mobility: "POOLED",
      customValues: { "projector.throw_ratio": { min: 1.35, max: 2.2 } },
    }),
  );
  deviceIds.push(device.id);
  const range = await db.customField.findUniqueOrThrow({
    where: { systemKey: "projector.throw_ratio" },
  });
  expect(range.unit).toBeNull();
  expect((await getFormFields("EQUIPMENT")).find((field) => field.id === range.id)?.unit).toBe(
    ": 1",
  );
  const form = new FormData();
  form.append(`cf.${range.id}`, "1.35");
  form.append(`cf.${range.id}`, "2.20");
  expect(
    await parseFieldForm("EQUIPMENT", form, device.customValues, device.kindId),
  ).toBeUndefined();
  await setEquipmentCustomValues(actor, device.id, {
    "projector.throw_ratio": { min: 1.35, max: 2.2 },
  });
  const logs = await db.activityLog.findMany({
    where: { entityId: device.id, action: "EquipmentUpdated" },
  });
  expect(logs).toHaveLength(1);
  expect(logs[0].data).toEqual({ custom: [] });
  await expect(
    setEquipmentCustomValues(actor, device.id, { "projector.throw_ratio": { min: NaN, max: 2.2 } }),
  ).rejects.toThrow();
});

it("copies valid legacy properties even when one text value exceeds its limit", async () => {
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "microphone" } });
  const device = await db.equipment.create({
    data: { category: "MICROPHONE", kindId: kind.id, band: "x".repeat(201), frequencyMhz: 823.1 },
  });
  deviceIds.push(device.id);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  await reconcileLibrary();
  const frequency = await db.customField.findUniqueOrThrow({ where: { systemKey: "frequency" } });
  expect(
    (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).customValues,
  ).toMatchObject({ [frequency.id]: 823.1 });
  expect(warning).toHaveBeenCalledWith(expect.any(String), {
    deviceId: device.id,
    fields: ["band_variant"],
  });
  expect((await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).band).toHaveLength(
    201,
  );
  expect((await db.libraryState.findUniqueOrThrow({ where: { key: "library" } })).version).toBe(
    propertyLibrary.version,
  );
});

it("clears obsolete legacy columns on a kind change and removes the old frequency from the board", async () => {
  await reconcileLibrary();
  const device = await createEquipment(
    actor,
    equipmentCreateSchema.parse({
      category: "MICROPHONE",
      mobility: "POOLED",
      frequencyMhz: 823.1,
      channelLabel: "Synthetic channel",
    }),
  );
  deviceIds.push(device.id);
  const changed = await updateEquipment(
    actor,
    device.id,
    equipmentCreateSchema.parse({ category: "PROJECTOR", mobility: "POOLED" }),
  );
  expect(changed).toMatchObject({ frequencyMhz: null, channelLabel: null });
  expect(
    (await listFrequencyBoard()).flatMap((group) => group.rows).some((row) => row.id === device.id),
  ).toBe(false);
});

it("preserves a concurrent property write when an update omits the legacy input", async () => {
  await reconcileLibrary();
  const device = await createEquipment(
    actor,
    equipmentCreateSchema.parse({
      category: "MICROPHONE",
      mobility: "POOLED",
      frequencyMhz: 823.1,
    }),
  );
  deviceIds.push(device.id);
  let release!: () => void, ready!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const writing = txWithAudit(actor, async (tx, audit) => {
    const data = await applyEquipmentCustomValuesInTx(tx, device.id, { frequency: 824.125 });
    await audit({ action: "EquipmentUpdated", entityType: "equipment", entityId: device.id, data });
    ready();
    await held;
  });
  await locked;
  const replacing = updateEquipment(
    actor,
    device.id,
    equipmentCreateSchema.parse({ category: "MICROPHONE", mobility: "POOLED" }),
  );
  try {
    await vi.waitFor(
      async () => {
        const [row] = await db.$queryRaw<
          { blocked: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%UPDATE%Equipment%') AS blocked`;
        expect(row.blocked).toBe(true);
      },
      { timeout: 5000 },
    );
  } finally {
    release();
  }
  await Promise.all([writing, replacing]);
  const frequency = await db.customField.findUniqueOrThrow({ where: { systemKey: "frequency" } });
  const row = await db.equipment.findUniqueOrThrow({ where: { id: device.id } });
  expect(Number(row.frequencyMhz)).toBe(824.125);
  expect(row.customValues).toMatchObject({ [frequency.id]: 824.125 });
});

it("copies seven legacy columns on 220 devices across ten kinds once, preserving filled properties", async () => {
  const kinds = await db.equipmentKind.findMany({
    where: { systemKey: { in: Object.values(DEFAULT_EQUIPMENT_KINDS).map((kind) => kind.key) } },
  });
  expect(kinds).toHaveLength(10);
  const devices = Array.from({ length: 220 }, (_, index) => {
    const kind = kinds[index % kinds.length];
    const category = Object.entries(DEFAULT_EQUIPMENT_KINDS).find(
      ([, entry]) => entry.key === kind.systemKey,
    )![0] as keyof typeof DEFAULT_EQUIPMENT_KINDS;
    const id = randomUUID();
    deviceIds.push(id);
    return {
      id,
      kindId: kind.id,
      category,
      name: `Synthetic unit ${index}`,
      mobility: "POOLED" as const,
      ...(category === "MICROPHONE"
        ? {
            micKind: ["HANDHELD", "BODYPACK", "GOOSENECK"][index % 3] as "HANDHELD",
            frequencyMhz: 500 + index / 1000,
            band: "Synthetic band",
            channelLabel: `Synthetic channel ${index}`,
            color: "Blue",
          }
        : {}),
      ...(category === "PROJECTOR" ? { lastLampChangeAt: new Date("2040-04-01T22:30:00Z") } : {}),
      ...(category === "PC" ? { dellServiceTag: `SYNTH${index}` } : {}),
      ...(["REMOTE", "MEDIA_CONTROL"].includes(category) ? { color: "Green" } : {}),
    };
  });
  await db.equipment.createMany({ data: devices });
  await reconcileLibrary();
  const fields = await getFieldSchema("EQUIPMENT");
  for (const kind of kinds)
    expect(fields.some((field) => field.kinds.some((link) => link.kindId === kind.id))).toBe(true);
  for (const device of await db.equipment.findMany({ where: { id: { in: deviceIds } } })) {
    const values = device.customValues as Record<string, unknown>;
    for (const [column, key] of Object.entries(legacyProperties)) {
      const raw = device[column as keyof typeof legacyProperties];
      if (raw == null) continue;
      const field = fields.find((field) => field.libraryKey === key)!;
      const expected =
        column === "frequencyMhz"
          ? Number(raw)
          : column === "lastLampChangeAt"
            ? berlinDateInput(raw as Date)
            : column === "micKind"
              ? field.options.find(
                  (option) =>
                    option.systemKey ===
                    {
                      HANDHELD: "handheld_transmitter",
                      BODYPACK: "bodypack_transmitter",
                      GOOSENECK: "gooseneck",
                    }[raw as "HANDHELD"],
                )!.id
              : raw;
      expect(values[field.id]).toEqual(expected);
    }
  }
  const microphone = devices.find((device) => device.category === "MICROPHONE")!;
  const channel = fields.find((field) => field.libraryKey === "channel_name")!;
  const row = await db.equipment.findUniqueOrThrow({ where: { id: microphone.id } });
  await db.equipment.update({
    where: { id: row.id },
    data: { customValues: { ...(row.customValues as object), [channel.id]: "House channel" } },
  });
  const count = await db.activityLog.count({
    where: { action: "LibraryDevicePropertiesCopied", entityId: { in: deviceIds } },
  });
  expect(count).toBeGreaterThan(0);
  expect(
    (await listRecentActivity()).items.filter(
      (entry) => entry.action === "LibraryDevicePropertiesCopied",
    ),
  ).toHaveLength(1);
  await reconcileLibrary();
  expect(
    await db.activityLog.count({
      where: { action: "LibraryDevicePropertiesCopied", entityId: { in: deviceIds } },
    }),
  ).toBe(count);
  expect(
    (await db.equipment.findUniqueOrThrow({ where: { id: row.id } })).customValues,
  ).toMatchObject({ [channel.id]: "House channel" });
});

it("dual-writes properties and legacy inputs, preserves omitted columns and reads the frequency board from properties", async () => {
  await reconcileLibrary();
  const input = equipmentCreateSchema.parse({
    category: "MICROPHONE",
    mobility: "POOLED",
    micKind: "HANDHELD",
    frequencyMhz: 823.1,
    band: "Synthetic band",
    channelLabel: "Old channel",
  });
  const device = await createEquipment(actor, input);
  deviceIds.push(device.id);
  const fields = await getFieldSchema("EQUIPMENT", { kindId: device.kindId });
  const id = (key: string) => fields.find((field) => field.libraryKey === key)!.id;
  expect(device.customValues).toMatchObject({
    [id("frequency")]: 823.1,
    [id("channel_name")]: "Old channel",
  });
  const changed = await updateEquipment(
    actor,
    device.id,
    equipmentCreateSchema.parse({
      category: "MICROPHONE",
      mobility: "POOLED",
      customValues: {
        frequency: 824.125,
        channel_name: "New channel",
        "microphone.type": "bodypack_transmitter",
      },
    }),
  );
  expect(Number(changed.frequencyMhz)).toBe(824.125);
  expect(changed).toMatchObject({
    micKind: "BODYPACK",
    channelLabel: "New channel",
    band: "Synthetic band",
  });
  await updateEquipment(actor, device.id, { ...input, frequencyMhz: 825.5 });
  expect(
    (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).customValues,
  ).toMatchObject({ [id("frequency")]: 825.5 });
  await db.equipment.update({
    where: { id: device.id },
    data: { frequencyMhz: null, channelLabel: "Stale column" },
  });
  const row = (await listFrequencyBoard())
    .flatMap((group) => group.rows)
    .find((row) => row.id === device.id);
  expect(row).toMatchObject({ frequencyMhz: "825.500", channelLabel: "Old channel" });
  await expect(
    setEquipmentCustomValues(actor, device.id, { frequency: 823.1234 }),
  ).rejects.toThrow();
  await setEquipmentCustomValues(actor, device.id, { frequency: null, channel_name: null });
  expect(await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).toMatchObject({
    frequencyMhz: null,
    channelLabel: null,
  });
});

it("dual-writes service tags, colour and lamp dates, and does not clone unit properties", async () => {
  await reconcileLibrary();
  for (const [category, column, key, before, after] of [
    ["PC", "dellServiceTag", "service_code", "SYNTH1", "SYNTH2"],
    ["REMOTE", "color", "colour", "Blue", "Green"],
    ["PROJECTOR", "lastLampChangeAt", "projector.lamp_change", "2040-04-02", "2040-05-03"],
  ] as const) {
    const device = await createEquipment(
      actor,
      equipmentCreateSchema.parse({ category, mobility: "POOLED", [column]: before }),
    );
    deviceIds.push(device.id);
    const changed = await setEquipmentCustomValues(actor, device.id, { [key]: after });
    expect(
      column === "lastLampChangeAt" ? berlinDateInput(changed.lastLampChangeAt) : changed[column],
    ).toBe(after);
    await setEquipmentCustomValues(actor, device.id, { [key]: null });
    expect((await db.equipment.findUniqueOrThrow({ where: { id: device.id } }))[column]).toBeNull();
  }
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "microphone" } });
  const source = await createEquipment(
    actor,
    equipmentCreateSchema.parse({
      kindId: kind.id,
      mobility: "POOLED",
      micKind: "HANDHELD",
      frequencyMhz: 823.1,
      channelLabel: "Unit channel",
      band: "Band",
    }),
  );
  deviceIds.push(source.id);
  const copy = await txWithAudit(actor, (tx, audit) =>
    createEquipmentInTx(tx, audit, {
      ...equipmentCreateSchema.parse({
        kindId: kind.id,
        mobility: "POOLED",
        micKind: source.micKind,
        band: source.band,
      }),
      copiedValues: source.customValues as Record<string, string>,
    }),
  );
  deviceIds.push(copy.id);
  const fields = await getFieldSchema("EQUIPMENT", { kindId: kind.id });
  expect(copy.customValues).not.toHaveProperty(
    fields.find((field) => field.libraryKey === "frequency")!.id,
  );
  expect(copy.customValues).not.toHaveProperty(
    fields.find((field) => field.libraryKey === "channel_name")!.id,
  );
  expect(copy).toMatchObject({
    frequencyMhz: null,
    channelLabel: null,
    micKind: "HANDHELD",
    band: "Band",
  });
});

it("validates range bounds on forms, imports and MCP without partial writes", async () => {
  await reconcileLibrary();
  const kind = await projector();
  const range = await db.customField.findUniqueOrThrow({
    where: { systemKey: "projector.throw_ratio" },
  });
  const input = equipmentCreateSchema.parse({ category: "PROJECTOR", mobility: "POOLED" });
  const device = await createEquipment(actor, input);
  deviceIds.push(device.id);
  const form = (min: string, max: string) => {
    const form = new FormData();
    form.append(`cf.${range.id}`, min);
    form.append(`cf.${range.id}`, max);
    return form;
  };
  expect(
    await runWithLocale("de", () => parseFieldForm("EQUIPMENT", form("1,35", "2,20"), {}, kind.id)),
  ).toEqual({ [range.key]: { min: 1.35, max: 2.2 } });
  await expect(parseFieldForm("EQUIPMENT", form("3", "2"), {}, kind.id)).rejects.toThrow();
  await expect(parseFieldForm("EQUIPMENT", form("bad", "2"), {}, kind.id)).rejects.toThrow();
  const csv = equipmentCsvRowSchema.parse({ kategorie: "PROJECTOR", mobilitaet: "POOLED" });
  await expect(
    bulkCreateEquipment(actor, [
      { ...csv, customValues: { "projector.throw_ratio": { min: 3, max: 2 } } },
    ]),
  ).rejects.toThrow();
  const user = await db.user.create({
    data: { name: "Synthetic range editor", email: `${randomUUID()}@example.test`, role: "ADMIN" },
  });
  const server = new McpServer({ name: "synthetic", version: "1" });
  registerFieldTools(server, {
    user,
    token: { id: "synthetic", name: "Synthetic token", scope: "READ_WRITE" },
  });
  const client = new Client({ name: "synthetic", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    for (const value of [
      { min: 3, max: 2 },
      { min: "1", max: 2 },
      {},
      { min: 1, max: 2, extra: 3 },
    ])
      expect(
        (
          await client.callTool({
            name: "set_custom_values",
            arguments: {
              scope: "EQUIPMENT",
              id: device.id,
              values: { "projector.throw_ratio": value },
            },
          })
        ).isError,
      ).toBe(true);
    for (const value of [{ min: 1.35, max: 2.2 }, { min: null, max: 2.2 }, { min: 1.35 }, null])
      expect(
        (
          await client.callTool({
            name: "set_custom_values",
            arguments: {
              scope: "EQUIPMENT",
              id: device.id,
              values: { "projector.throw_ratio": value },
            },
          })
        ).isError,
      ).not.toBe(true);
    expect(
      (await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).customValues,
    ).not.toHaveProperty(range.id);
  } finally {
    await client.close();
    await server.close();
    await db.user.delete({ where: { id: user.id } });
  }
});
async function own(type: "TEXT" | "CHOICE" | "NUMBER" = "TEXT", name: string = randomUUID()) {
  const kind = await projector();
  const field = await db.customField.create({
    data: {
      scope: "EQUIPMENT",
      key: `f_${randomUUID().replaceAll("-", "")}`,
      name,
      type,
      position: 77,
      kinds: { create: { kindId: kind.id } },
    },
  });
  ownIds.push(field.id);
  return field;
}

it("ships bilingual renderable properties, valid units, conditions and cited sources", () => {
  const all = [...propertyLibrary.sharedProperties, ...propertyLibrary.properties];
  expect(new Set(all.map((property) => property.key)).size).toBe(all.length);
  expect(
    propertyLibrary.kinds.filter((kind) => kind.properties?.length).map((kind) => kind.key),
  ).toHaveLength(59);
  expect(all).toHaveLength(550);
  for (const property of all) {
    expect(property.de).not.toBe("");
    expect(property.en).not.toBe("");
    expect([
      "TEXT",
      "LONG_TEXT",
      "NUMBER",
      "BOOLEAN",
      "CHOICE",
      "MULTI_CHOICE",
      "DATE",
      "LINK",
      "RANGE",
    ]).toContain(property.type);
    if (property.unit)
      expect(propertyLibrary.units.some((unit) => unit.key === property.unit)).toBe(true);
    expect(new Set(property.options.map((option) => option.key)).size).toBe(
      property.options.length,
    );
    for (const option of property.options) {
      expect(option.de).not.toBe("");
      expect(option.en).not.toBe("");
    }
    for (const source of property.sources) expect(Object.hasOwn(sources, source)).toBe(true);
    if (property.appliesIf) {
      for (const kind of propertyLibrary.kinds.filter((kind) =>
        kind.properties?.includes(property.key),
      ))
        expect(kind.properties).toContain(property.appliesIf.property);
      const condition = libraryProperties.get(property.appliesIf.property)!;
      for (const key of property.appliesIf.values)
        expect(condition.options.some((option) => option.key === key)).toBe(true);
    }
  }
});

it("reconciles installed kinds once, preserving identities, positions and audit count", async () => {
  const ids = await reconcileLibrary();
  expect(ids).toHaveLength(await installedPropertyCount());
  const fields = await getFieldSchema("EQUIPMENT", {
    kindId: (await projector()).id,
    locale: "en",
  });
  expect(fields.find((field) => field.libraryKey === "projector.light_source")).toMatchObject({
    name: "Light source",
    level: "MODEL",
    origin: "library",
    options: expect.arrayContaining([expect.objectContaining({ key: "laser", label: "Laser" })]),
  });
  const count = await db.activityLog.count({ where: { entityId: { in: ids } } });
  expect(await reconcileLibrary()).toEqual([]);
  expect(await db.activityLog.count({ where: { entityId: { in: ids } } })).toBe(count);
  expect(await db.libraryState.findUnique({ where: { key: "library" } })).toMatchObject({
    version: propertyLibrary.version,
  });
});

it("preserves hiding and renaming while adding a property and option on a version bump", async () => {
  await reconcileLibrary();
  const light = await db.customField.findUniqueOrThrow({
    where: { systemKey: "projector.light_source" },
  });
  await updateCustomField(actor, { id: light.id, archived: true });
  await db.customField.update({
    where: { id: light.id },
    data: { renamed: true, name: "House property", position: -7 },
  });
  const next = structuredClone(propertyLibrary);
  next.version++;
  next.properties
    .find((property) => property.key === light.systemKey)!
    .options.push({ key: "synthetic", de: "Synthetisch", en: "Synthetic" });
  next.properties.push({
    ...next.properties[0],
    key: "projector.synthetic",
    de: "Synthetisch",
    en: "Synthetic",
  });
  next.kinds.find((kind) => kind.key === "projector")!.properties!.push("projector.synthetic");
  await reconcileLibrary(next);
  expect(await db.customField.findUnique({ where: { id: light.id } })).toMatchObject({
    name: "House property",
    position: -7,
    archivedAt: expect.any(Date),
  });
  expect(
    await db.customFieldOption.findFirst({ where: { fieldId: light.id, systemKey: "synthetic" } }),
  ).not.toBeNull();
  expect(
    await db.customField.findUnique({ where: { systemKey: "projector.synthetic" } }),
  ).not.toBeNull();
});

it("refuses retyping or releveling and rolls back the entire reconcile", async () => {
  await reconcileLibrary();
  for (const change of [{ type: "TEXT" as const }, { level: "DEVICE" as const }]) {
    const next = structuredClone(propertyLibrary);
    next.version++;
    Object.assign(next.properties[0], change);
    await expect(reconcileLibrary(next)).rejects.toThrow("cannot change type or level");
    expect((await db.libraryState.findUniqueOrThrow({ where: { key: "library" } })).version).toBe(
      propertyLibrary.version,
    );
  }
});

it("adopts a matching own choice without losing its IDs, order or values; keeps a mismatch", async () => {
  const matching = await own("CHOICE", "Light source");
  const option = await db.customFieldOption.create({
    data: { fieldId: matching.id, label: "Laser" },
  });
  const mismatch = await own("TEXT", "Helligkeit (Weißlichtstrom)");
  const kind = await projector();
  const device = await db.equipment.create({
    data: { category: "PROJECTOR", kindId: kind.id, customValues: { [matching.id]: option.id } },
  });
  deviceIds.push(device.id);
  await reconcileLibrary();
  expect(await db.customField.findUnique({ where: { id: matching.id } })).toMatchObject({
    systemKey: "projector.light_source",
    position: 77,
    level: "MODEL",
  });
  expect(await db.customFieldOption.findUnique({ where: { id: option.id } })).toMatchObject({
    systemKey: "laser",
  });
  expect((await db.equipment.findUniqueOrThrow({ where: { id: device.id } })).customValues).toEqual(
    { [matching.id]: option.id },
  );
  expect(await db.customField.findUnique({ where: { id: mismatch.id } })).toMatchObject({
    systemKey: null,
  });
  expect(
    await db.customField.findUnique({ where: { systemKey: "projector.brightness" } }),
  ).not.toBeNull();
});

it.each(["two kinds", "all devices"])(
  "keeps a colliding own property covering %s separate",
  async (coverage) => {
    const field = await own("CHOICE", "Lichtquelle");
    if (coverage === "all devices")
      await db.customFieldKind.deleteMany({ where: { fieldId: field.id } });
    else {
      const other = await db.equipmentKind.findFirstOrThrow({
        where: { id: { not: (await projector()).id } },
      });
      await db.customFieldKind.create({ data: { fieldId: field.id, kindId: other.id } });
    }
    await reconcileLibrary();
    expect(
      (await db.customField.findUniqueOrThrow({ where: { id: field.id } })).systemKey,
    ).toBeNull();
    expect(
      (await db.customField.findUniqueOrThrow({ where: { systemKey: "projector.light_source" } }))
        .id,
    ).not.toBe(field.id);
  },
);

it("exposes RANGE and resolves a removed library key as an own property", async () => {
  const removed = await own();
  await db.customField.update({
    where: { id: removed.id },
    data: { systemKey: "removed.property" },
  });
  const range = await own();
  await db.customField.update({ where: { id: range.id }, data: { type: "RANGE" } });
  const fields = await getFieldSchema("EQUIPMENT");
  expect(fields.find((field) => field.id === removed.id)).toMatchObject({
    origin: "own",
    libraryKey: null,
    name: removed.name,
  });
  expect(fields.some((field) => field.id === range.id)).toBe(true);
  expect((await getFormFields("EQUIPMENT")).some((field) => field.id === range.id)).toBe(true);
});

it.each([
  { name: "Gewicht", key: "weight", unit: "kg", adopt: true },
  { name: "Gewicht", key: "weight", unit: " KG ", adopt: true },
  { name: "Gewicht", key: "weight", unit: "g", adopt: false },
  { name: "Gewicht", key: "weight", unit: null, adopt: false },
  { name: "Lampenanzahl", key: "projector.lamp_count", unit: " StK. ", adopt: true },
])("adopts $name with unit $unit only when units agree", async ({ name, key, unit, adopt }) => {
  const field = await own("NUMBER", name);
  await db.customField.update({ where: { id: field.id }, data: { unit } });
  await reconcileLibrary();
  const library = await db.customField.findUniqueOrThrow({ where: { systemKey: key } });
  expect(library.id === field.id).toBe(adopt);
  expect((await db.customField.findUniqueOrThrow({ where: { id: field.id } })).unit).toBe(unit);
});

it("refuses an unsupported type before creating any library rows", async () => {
  const next = structuredClone(propertyLibrary);
  Object.assign(next.properties[0], { type: "RELATION" });
  await expect(reconcileLibrary(next)).rejects.toThrow("unsupported type");
  expect(await db.customField.count({ where: { systemKey: { not: null } } })).toBe(0);
  expect(await db.libraryState.count()).toBe(0);
});

it("keeps a removed model property writable and preserves its values during own-property operations", async () => {
  const kind = await projector();
  const field = await own("CHOICE");
  await db.customField.update({
    where: { id: field.id },
    data: { systemKey: "removed.choice", level: "MODEL" },
  });
  const option = await db.customFieldOption.create({
    data: { fieldId: field.id, label: "Synthetic" },
  });
  const model = await db.equipmentModel.create({
    data: { name: randomUUID(), category: "PROJECTOR", kindId: kind.id },
  });
  modelIds.push(model.id);
  await setModelValues(actor, model.id, { [field.key]: option.id });
  await expect(deleteCustomField(actor, field.id)).rejects.toThrow();
  await updateCustomField(actor, { id: field.id, type: "MULTI_CHOICE" });
  expect(
    (await db.equipmentModel.findUniqueOrThrow({ where: { id: model.id } })).customValues,
  ).toEqual({ [field.id]: [option.id] });
  await setModelValues(actor, model.id, { [field.key]: null });
  await deleteCustomField(actor, field.id);
});

it("keeps startup alive after a failed reconcile and retries at the next start", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const query = vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("Synthetic failure"));
  await expect(register()).resolves.toBeUndefined();
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("reconcile failed"),
    expect.any(Error),
  );
  query.mockRestore();
  await register();
  expect(await db.customField.count({ where: { systemKey: { not: null } } })).toBe(
    await installedPropertyCount(),
  );
});

it("installs projector properties in the kind-install transaction", async () => {
  const original = await projector();
  await db.equipmentKind.update({
    where: { id: original.id },
    data: { systemKey: null, name: randomUUID() },
  });
  let installedId: string | undefined;
  try {
    const result = await installLibraryKinds(actor, { keys: ["projector"] });
    installedId = result.installed[0].id;
    expect(await db.customFieldKind.count({ where: { kindId: installedId } })).toBe(
      propertyLibrary.kinds.find((kind) => kind.key === "projector")!.properties!.length,
    );
  } finally {
    await db.customField.deleteMany({ where: { systemKey: { not: null } } });
    if (installedId) await db.equipmentKind.delete({ where: { id: installedId } });
    await db.equipmentKind.update({
      where: { id: original.id },
      data: { systemKey: original.systemKey, name: original.name },
    });
  }
});

it("excludes 60 library rows from own-field limits and protects library definitions", async () => {
  await reconcileLibrary();
  const kind = await projector();
  const count = await db.customFieldKind.count({ where: { kindId: kind.id } });
  for (let n = count; n < 60; n++) {
    const field = await own();
    libraryProperties.set(`synthetic.${n}`, {
      ...propertyLibrary.properties[0],
      key: `synthetic.${n}`,
    });
    await db.customField.update({ where: { id: field.id }, data: { systemKey: `synthetic.${n}` } });
  }
  for (let n = 0; n < 40; n++)
    ownIds.push(
      (
        await createCustomField(actor, {
          scope: "EQUIPMENT",
          key: `own_${randomUUID().replaceAll("-", "")}`,
          name: randomUUID(),
          type: "TEXT",
          kindIds: [kind.id],
        })
      ).id,
    );
  await expect(
    createCustomField(actor, {
      scope: "EQUIPMENT",
      key: "one_too_many",
      name: randomUUID(),
      type: "TEXT",
      kindIds: [kind.id],
    }),
  ).rejects.toThrow();
  const field = await db.customField.findUniqueOrThrow({
    where: { systemKey: "projector.light_source" },
  });
  await expect(deleteCustomField(actor, field.id)).rejects.toThrow();
  await expect(updateCustomField(actor, { id: field.id, type: "TEXT" })).rejects.toThrow();
  await expect(updateCustomField(actor, { id: field.id, kindIds: [] })).rejects.toThrow();
  await expect(
    updateFieldOptions(actor, { fieldId: field.id, changes: [{ op: "add", label: "Own" }] }),
  ).rejects.toThrow();
  await expect(
    createCustomField(actor, {
      scope: "EQUIPMENT",
      key: "reserved_name",
      name: "LIGHT SOURCE",
      type: "TEXT",
      kindIds: [kind.id],
    }),
  ).rejects.toMatchObject({ fieldErrors: { name: expect.any(Array) } });
  await expect(
    updateCustomField(actor, { id: ownIds[ownIds.length - 1], name: "Lichtquelle" }),
  ).rejects.toMatchObject({ fieldErrors: { name: expect.any(Array) } });
});

it("reads model values on every device, falls back to device values, and enforces the writing rule", async () => {
  await reconcileLibrary();
  const kind = await projector();
  const model = await db.equipmentModel.create({
    data: { category: "PROJECTOR", kindId: kind.id, name: randomUUID() },
  });
  modelIds.push(model.id);
  const light = await db.customField.findUniqueOrThrow({
    where: { systemKey: "projector.light_source" },
    include: { options: true },
  });
  const lamp = light.options.find((option) => option.systemKey === "lamp")!;
  const devices = [];
  for (let n = 0; n < 2; n++) {
    const device = await db.equipment.create({
      data: {
        category: "PROJECTOR",
        kindId: kind.id,
        modelId: model.id,
        customValues: { [light.id]: lamp.id },
      },
    });
    deviceIds.push(device.id);
    devices.push(device);
  }
  expect(
    (await withFieldValues("EQUIPMENT", devices))[0].fields.find((field) => field.id === light.id),
  ).toMatchObject({ from: "device", value: "Lampe" });
  await expect(
    setEquipmentCustomValues(actor, devices[0].id, { "projector.light_source": "laser" }),
  ).rejects.toMatchObject({
    fieldErrors: { [light.key]: [expect.stringContaining(`/inventory/models/${model.id}`)] },
  });
  await setModelValues(actor, model.id, { "projector.light_source": "laser" });
  expect(
    (
      await db.activityLog.findFirstOrThrow({
        where: { entityType: "equipmentModel", entityId: model.id },
        orderBy: { occurredAt: "desc" },
      })
    ).data,
  ).toMatchObject({ custom: [{ key: light.key, name: "Lichtquelle", from: null, to: "Laser" }] });
  await setModelValues(actor, model.id, { "projector.light_source": "laser" });
  expect(
    (
      await db.activityLog.findFirstOrThrow({
        where: { entityType: "equipmentModel", entityId: model.id },
        orderBy: { occurredAt: "desc" },
      })
    ).data,
  ).toEqual({ custom: [] });
  for (const device of await withFieldValues("EQUIPMENT", devices))
    expect(device.fields.find((field) => field.id === light.id)).toMatchObject({
      from: "model",
      value: "Laser",
    });
  const list = await withListValues(
    "EQUIPMENT",
    devices.map((device) => ({ ...device, kind: { id: kind.id } })),
    [`field:${light.id}`],
  );
  expect(list.map((device) => device.values[light.id])).toEqual([
    light.options.find((option) => option.systemKey === "laser")!.id,
    light.options.find((option) => option.systemKey === "laser")!.id,
  ]);
  expect(
    (await getListColumns("EQUIPMENT", true)).fields.some((field) => field.id === light.id),
  ).toBe(true);
  await setModelValues(actor, model.id, { "projector.light_source": null });
  await expect(
    setEquipmentCustomValues(actor, devices[0].id, { "projector.light_source": "laser" }),
  ).rejects.toThrow();
  await updateEquipment(
    actor,
    devices[0].id,
    equipmentCreateSchema.parse({
      kindId: kind.id,
      mobility: "POOLED",
      customValues: { "projector.light_source": "laser" },
    }),
  );
  expect(
    (await db.equipment.findUniqueOrThrow({ where: { id: devices[0].id } })).modelId,
  ).toBeNull();
  await expect(
    setModelValues(actor, model.id, { "projector.lamp_change": "2040-01-01" }),
  ).rejects.toThrow();
  await expect(
    db.$executeRaw`UPDATE "EquipmentModel" SET "customValues" = '[]'::jsonb WHERE id = ${model.id}`,
  ).rejects.toThrow("equipment_model_custom_values");
  await expect(
    db.$executeRaw`UPDATE "EquipmentModel" SET "customValues" = ${JSON.stringify({ large: "x".repeat(40000) })}::jsonb WHERE id = ${model.id}`,
  ).rejects.toThrow("equipment_model_custom_values");
});
