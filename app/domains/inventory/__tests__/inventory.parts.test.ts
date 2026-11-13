import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import { ValidationError } from "~/lib/errors.server";
import { initializeEquipmentKinds } from "~/lib/equipment-kinds/kinds.server";
import { installLibraryKinds } from "~/lib/equipment-kinds/library.server";
import {
  addPartStock,
  takePartForDevice,
  linkStockModel,
} from "../inventory.parts.mutations.server";
import { setModelPartFit } from "~/domains/catalog/catalog.parts.mutations.server";
import { modelParts, partDetail } from "../inventory.parts.queries.server";
import { updateStockItem } from "../inventory.stock.mutations.server";
import { stockEditSchema } from "../inventory.stock.schema";
import { updateModel } from "~/domains/catalog/catalog.mutations.server";
import { updateDeviceKind } from "~/lib/equipment-kinds/structure.server";
import parts from "~/lib/catalog/parts.json";
import library from "~/lib/equipment-kinds/library.json";
import * as emit from "~/lib/realtime/emit.server";
import * as audit from "~/lib/audit.server";

const models: string[] = [],
  devices: string[] = [],
  stock: string[] = [],
  kinds: string[] = [];
let actor: { id: string; name: string };
beforeAll(async () => {
  await initializeEquipmentKinds();
  actor = await db.user.create({
    data: { name: "Synthetic parts member", email: `${randomUUID()}@example.test`, role: "MEMBER" },
  });
  const missing = ["projector_lamp", "projector_filter", "rechargeable_battery"].filter(
    (key) => !library.kinds.some((kind) => kind.key === key),
  );
  expect(missing).toEqual([]);
  const installed = await db.equipmentKind.findMany({
    where: { systemKey: { in: ["projector_lamp", "projector_filter", "rechargeable_battery"] } },
  });
  const keys = ["projector_lamp", "projector_filter", "rechargeable_battery"].filter(
    (key) => !installed.some((kind) => kind.systemKey === key),
  );
  if (keys.length)
    kinds.push(...(await installLibraryKinds(actor, { keys })).installed.map((kind) => kind.id));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.inventoryItem.deleteMany({ where: { id: { in: stock.splice(0) } } });
  await db.equipment.deleteMany({ where: { id: { in: devices.splice(0) } } });
  await db.modelPartFit.deleteMany({ where: { modelId: { in: models } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: models.splice(0) } } });
});
afterAll(async () => {
  const fields = await db.customFieldKind.findMany({ where: { kindId: { in: kinds } } });
  await db.customFieldKind.deleteMany({ where: { kindId: { in: kinds } } });
  await db.customField.deleteMany({
    where: { id: { in: fields.map((field) => field.fieldId) }, kinds: { none: {} } },
  });
  await db.equipmentKind.deleteMany({ where: { id: { in: kinds } } });
  await db.user.delete({ where: { id: actor.id } });
  await db.$disconnect();
});
async function fixture() {
  const hostKind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  const partKind = await db.equipmentKind.findUniqueOrThrow({
    where: { systemKey: "projector_filter" },
  });
  const host = await db.equipmentModel.create({
    data: { name: `Synthetic laser ${randomUUID()}`, category: "PROJECTOR", kindId: hostKind.id },
  });
  const part = await db.equipmentModel.create({
    data: { name: `FILTER-${randomUUID()}`, category: "OTHER", kindId: partKind.id },
  });
  models.push(host.id, part.id);
  const device = await db.equipment.create({
    data: {
      name: "Synthetic projector 33",
      category: "PROJECTOR",
      kindId: hostKind.id,
      modelId: host.id,
    },
  });
  devices.push(device.id);
  await setModelPartFit(actor, host.id, { partModelId: part.id });
  const item = await addPartStock(actor, part.id, 2);
  stock.push(item.id);
  return { host, part, device, item };
}

it("ships the researched kinds and only verified manufacturer fits without inventing a laser lamp or quantity", () => {
  expect(library.partKinds).toHaveLength(48);
  for (const key of library.partKinds)
    expect(library.kinds.find((kind) => kind.key === key)?.properties.length).toBeGreaterThan(0);
  expect(parts.records).toHaveLength(32);
  expect(parts.fits).toHaveLength(159);
  expect(parts.fits.filter((fit) => fit.modelKey === "epson-eb-l1750u")).toEqual([
    {
      modelKey: "epson-eb-l1750u",
      partKey: "epson-elpaf51",
      quantity: null,
      sourceUrl: "https://www.epson.eu/en_EU/products/projector/professional/eb-l1750u/p/22343",
    },
  ]);
  expect(new Set(parts.fits.map((fit) => `${fit.modelKey}:${fit.partKey}`)).size).toBe(
    parts.fits.length,
  );
  for (const fit of parts.fits) {
    expect(parts.records.some((record) => record.key === fit.partKey)).toBe(true);
    expect(["www.epson.eu", "www.epson.co.uk"]).toContain(new URL(fit.sourceUrl).hostname);
  }
});

it("shows all fitting devices and keeps the count tied to the model through stock edits", async () => {
  const { host, part, device, item } = await fixture();
  const second = await db.equipment.create({ data: { category: "PROJECTOR", modelId: host.id } });
  devices.push(second.id);
  expect((await partDetail(part.id))!.fits[0].devices.map((row) => row.id).sort()).toEqual(
    [device.id, second.id].sort(),
  );
  await updateStockItem(
    actor,
    item.id,
    stockEditSchema.parse({ id: item.id, name: item.name, quantity: 3 }),
  );
  expect((await modelParts(host.id))[0].count).toBe(3);
  expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).modelId).toBe(
    part.id,
  );
});

it("takes one atomically, audits both histories and emits only after commit", async () => {
  const { host, part, device, item } = await fixture();
  const spy = vi.spyOn(emit, "emitChange").mockImplementation(async () => {
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantity).toBe(1);
  });
  await takePartForDevice(actor, device.id, item.id);
  expect((await modelParts(host.id))[0].count).toBe(1);
  expect((await partDetail(part.id))!.count).toBe(1);
  const rows = await db.activityLog.findMany({
    where: { action: "PartTakenForDevice", entityId: { in: [device.id, item.id] } },
  });
  expect(rows).toHaveLength(2);
  for (const row of rows)
    expect(row.data).toMatchObject({
      equipmentId: device.id,
      partModelId: part.id,
      partNumber: part.name,
      from: 2,
      to: 1,
    });
  expect(spy).toHaveBeenCalledTimes(4);
});

it("allows only one of two devices to take the final part", async () => {
  const { host, device, item } = await fixture();
  const second = await db.equipment.create({ data: { category: "PROJECTOR", modelId: host.id } });
  devices.push(second.id);
  await db.inventoryItem.update({ where: { id: item.id }, data: { quantity: 1 } });
  const results = await Promise.allSettled([
    takePartForDevice(actor, device.id, item.id),
    takePartForDevice(actor, second.id, item.id),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantity).toBe(0);
  expect(
    await db.activityLog.count({ where: { action: "PartTakenForDevice", entityId: item.id } }),
  ).toBe(1);
});

it("refuses unavailable, assigned, stale-model and retired-device requests without audit or notification", async () => {
  const { device, item } = await fixture();
  const spy = vi.spyOn(emit, "emitChange");
  for (const data of [
    { status: "ON_LOAN" as const },
    { status: null, equipmentId: device.id },
    { equipmentId: null, quantity: 0 },
  ]) {
    await db.inventoryItem.update({ where: { id: item.id }, data });
    await expect(takePartForDevice(actor, device.id, item.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
  }
  await db.inventoryItem.update({ where: { id: item.id }, data: { quantity: 2 } });
  await db.equipment.update({ where: { id: device.id }, data: { status: "RETIRED" } });
  await expect(takePartForDevice(actor, device.id, item.id)).rejects.toBeInstanceOf(
    ValidationError,
  );
  await db.equipment.update({
    where: { id: device.id },
    data: { status: "OPERATIONAL", modelId: null },
  });
  await expect(takePartForDevice(actor, device.id, item.id)).rejects.toBeInstanceOf(
    ValidationError,
  );
  expect(
    await db.activityLog.count({ where: { action: "PartTakenForDevice", entityId: item.id } }),
  ).toBe(0);
  expect(spy).not.toHaveBeenCalled();
});

it("rolls back the decrement when the audit insert fails", async () => {
  const { device, item } = await fixture();
  const spy = vi.spyOn(emit, "emitChange");
  const original = audit.txWithAudit;
  vi.spyOn(audit, "txWithAudit").mockImplementation((actor, work, options) =>
    original(
      actor,
      (tx) =>
        work(tx, async () => {
          throw new Error("Synthetic audit failure");
        }),
      options,
    ),
  );
  await expect(takePartForDevice(actor, device.id, item.id)).rejects.toThrow(
    "Synthetic audit failure",
  );
  expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantity).toBe(2);
  expect(spy).not.toHaveBeenCalled();
});

it("enforces distinct models, positive known quantities and unique fits in PostgreSQL", async () => {
  const { host, part } = await fixture();
  await expect(
    db.modelPartFit.create({ data: { modelId: host.id, partModelId: host.id } }),
  ).rejects.toThrow();
  await expect(
    db.modelPartFit.updateMany({
      where: { modelId: host.id, partModelId: part.id },
      data: { quantity: 0 },
    }),
  ).rejects.toThrow();
  await expect(
    db.modelPartFit.create({ data: { modelId: host.id, partModelId: part.id } }),
  ).rejects.toThrow();
  await db.modelPartFit.updateMany({ where: { modelId: host.id }, data: { quantity: 2 } });
  await expect(db.equipmentModel.delete({ where: { id: part.id } })).rejects.toThrow();
});

it("links existing stock without guessing from names and audits relinking and clearing", async () => {
  const { host, part, item } = await fixture();
  await linkStockModel(actor, item.id, null);
  expect((await modelParts(host.id))[0].count).toBe(0);
  await linkStockModel(actor, item.id, part.id);
  expect((await modelParts(host.id))[0].count).toBe(2);
  const rows = await db.activityLog.findMany({
    where: { action: "StockModelLinked", entityId: item.id },
  });
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.data)).toEqual(
    expect.arrayContaining([
      { from: part.id, to: null },
      { from: null, to: part.id },
    ]),
  );
});

it("refuses receiving stock for a non-part model", async () => {
  const { host } = await fixture();
  await expect(addPartStock(actor, host.id, 1)).rejects.toBeInstanceOf(ValidationError);
  expect(await db.inventoryItem.count({ where: { modelId: host.id } })).toBe(0);
});

it("rejects non-part kind changes while either compatibility or stock references remain", async () => {
  const { host, part, item } = await fixture();
  const input = { name: part.name, kindId: host.kindId! };
  const before = await db.activityLog.count();
  await expect(updateModel(actor, part.id, input)).rejects.toBeInstanceOf(ValidationError);
  expect((await db.equipmentModel.findUniqueOrThrow({ where: { id: part.id } })).kindId).toBe(
    part.kindId,
  );
  expect(await db.activityLog.count()).toBe(before);
  await linkStockModel(actor, item.id, null);
  await expect(updateModel(actor, part.id, input)).rejects.toBeInstanceOf(ValidationError);
  await linkStockModel(actor, item.id, part.id);
  await setModelPartFit(actor, host.id, { partModelId: part.id, remove: true });
  await expect(updateModel(actor, part.id, input)).rejects.toBeInstanceOf(ValidationError);
  await linkStockModel(actor, item.id, null);
  await expect(updateModel(actor, part.id, input)).resolves.toMatchObject({ kindId: host.kindId });
});

it("rejects bulk kind moves without changing the kind, references or audit", async () => {
  const { host, part } = await fixture();
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { id: part.kindId! } });
  const before = await db.activityLog.count();
  await expect(
    updateDeviceKind(actor, kind.id, {
      name: kind.name,
      archived: true,
      moveDevicesTo: host.kindId!,
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(
    (await db.equipmentKind.findUniqueOrThrow({ where: { id: kind.id } })).archivedAt,
  ).toBeNull();
  expect((await db.equipmentModel.findUniqueOrThrow({ where: { id: part.id } })).kindId).toBe(
    kind.id,
  );
  expect(await db.modelPartFit.count({ where: { partModelId: part.id } })).toBe(1);
  expect(await db.activityLog.count()).toBe(before);
});

it("allows a referenced part to move to another part kind without disabling stock actions", async () => {
  const { part, device, item } = await fixture();
  const kind = await db.equipmentKind.findUniqueOrThrow({
    where: { systemKey: "rechargeable_battery" },
  });
  await updateModel(actor, part.id, { name: part.name, kindId: kind.id });
  await takePartForDevice(actor, device.id, item.id);
  expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantity).toBe(1);
});

it("keeps manufacturer fits protected, allows manual unlinking and refuses inactive writers", async () => {
  const { host, part, device, item } = await fixture();
  await db.modelPartFit.updateMany({
    where: { modelId: host.id },
    data: { catalogKey: "synthetic-catalog" },
  });
  await expect(
    setModelPartFit(actor, host.id, { partModelId: part.id, remove: true }),
  ).rejects.toBeInstanceOf(ValidationError);
  await db.modelPartFit.updateMany({ where: { modelId: host.id }, data: { catalogKey: null } });
  await setModelPartFit(actor, host.id, { partModelId: part.id, remove: true });
  expect(await modelParts(host.id)).toEqual([]);
  await expect(takePartForDevice(actor, device.id, item.id)).rejects.toBeInstanceOf(
    ValidationError,
  );
  await db.user.update({ where: { id: actor.id }, data: { isActive: false } });
  try {
    await expect(addPartStock(actor, part.id, 1)).rejects.toMatchObject({ status: 403 });
    await expect(setModelPartFit(actor, host.id, { partModelId: part.id })).rejects.toMatchObject({
      status: 403,
    });
    await expect(linkStockModel(actor, item.id, null)).rejects.toMatchObject({ status: 403 });
  } finally {
    await db.user.update({ where: { id: actor.id }, data: { isActive: true } });
  }
});
