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
import { setEquipmentCustomValues } from "~/domains/inventory/inventory.custom-values.server";
import { setModelValues } from "~/domains/catalog/catalog.values.server";
import { getListColumns, withListValues } from "~/lib/list-columns/columns.server";
import { updateEquipment } from "~/domains/inventory/inventory.mutations.server";
import { equipmentCreateSchema } from "~/domains/inventory/inventory.schema";

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
  ).toEqual(["projector"]);
  expect(all).toHaveLength(39);
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
      expect(propertyLibrary.kinds.find((kind) => kind.key === "projector")!.properties).toContain(
        property.appliesIf.property,
      );
      const condition = libraryProperties.get(property.appliesIf.property)!;
      for (const key of property.appliesIf.values)
        expect(condition.options.some((option) => option.key === key)).toBe(true);
    }
  }
});

it("reconciles installed kinds once, preserving identities, positions and audit count", async () => {
  const ids = await reconcileLibrary();
  expect(ids).toHaveLength(39);
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

it("skips RANGE and resolves a removed library key as an own property", async () => {
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
  expect(fields.some((field) => field.id === range.id)).toBe(false);
  expect((await getFormFields("EQUIPMENT")).some((field) => field.id === range.id)).toBe(false);
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
  Object.assign(next.properties[0], { type: "RANGE" });
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
  expect(await db.customField.count({ where: { systemKey: { not: null } } })).toBe(39);
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
    expect(await db.customFieldKind.count({ where: { kindId: installedId } })).toBe(39);
  } finally {
    await db.customField.deleteMany({ where: { systemKey: { not: null } } });
    if (installedId) await db.equipmentKind.delete({ where: { id: installedId } });
    await db.equipmentKind.update({
      where: { id: original.id },
      data: { systemKey: original.systemKey, name: original.name },
    });
  }
});

it("excludes 40 library rows from own-field limits and protects library definitions", async () => {
  await reconcileLibrary();
  const kind = await projector();
  for (let n = 0; n < 3; n++) {
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
