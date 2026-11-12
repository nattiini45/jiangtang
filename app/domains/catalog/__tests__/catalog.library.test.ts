import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { reconcileLibrary } from "~/lib/custom-fields/library.server";
import { getFieldSchema } from "~/lib/custom-fields/schema.server";
import { withFieldValues } from "~/lib/custom-fields/display.server";
import { initializeEquipmentKinds } from "~/lib/equipment-kinds/kinds.server";
import {
  loadModelCatalog,
  modelCatalogSchema,
  type CatalogRecord,
} from "~/lib/catalog/catalog.server";
import { register } from "~/lib/catalog/catalog.boot.server";
import {
  applyCatalogModelInTx,
  reconcileModelCatalog,
  unlinkCatalogModel,
} from "../catalog.library.server";
import { getModel, catalogModelOptions } from "../catalog.queries.server";
import { setModelValues } from "../catalog.values.server";
import { setEquipmentModelPorts } from "../catalog.ports.mutations.server";
import { createEquipment } from "~/domains/inventory/inventory.mutations.server";
import { listActivity, encodeActivityCursor } from "~/domains/activity/activity.queries.server";
import { ValidationError } from "~/lib/errors.server";

const ids: string[] = [],
  devices: string[] = [],
  kindIds: string[] = [];
let admin: { id: string; name: string };
const port = {
  label: "HDMI IN",
  connector: "HDMI",
  direction: "INPUT",
  signal: "AUDIO_VIDEO",
} as const;
const synthetic = (): CatalogRecord => ({
  key: `synthetic-${randomUUID()}`,
  manufacturer: "Synthetic",
  name: randomUUID(),
  kind: "projector",
  productUrl: "https://example.test/projector",
  manualUrl: "https://example.test/manual",
  aliases: [],
  partNumbers: [],
  values: { "projector.brightness": 15000, "projector.light_source": "laser", weight: 24.1 },
  ports: [port],
  sources: [{ url: "https://example.test/projector", retrievedOn: "2026-11-12" }],
});
const kind = () => db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
async function model(record: CatalogRecord, extra = {}) {
  const created = await db.equipmentModel.create({
    data: {
      name: record.name,
      manufacturer: record.manufacturer,
      category: "PROJECTOR",
      kindId: (await kind()).id,
      ...extra,
    },
  });
  ids.push(created.id);
  return created;
}
async function device(modelId: string) {
  const created = await db.equipment.create({
    data: { category: "PROJECTOR", kindId: (await kind()).id, modelId },
  });
  devices.push(created.id);
  return created;
}
async function apply(record: CatalogRecord, version: number, modelId?: string) {
  const result = await txWithAudit(admin, (tx, audit) =>
    applyCatalogModelInTx(tx, audit, record, version, modelId),
  );
  if (!ids.includes(result.model.id)) ids.push(result.model.id);
  return result;
}
async function values(modelId: string) {
  return (await getModel(modelId))!.customValues as Record<string, unknown>;
}
beforeEach(async () => {
  await initializeEquipmentKinds();
  await reconcileLibrary();
  admin = await db.user.create({
    data: { name: "Synthetic catalog admin", email: `${randomUUID()}@example.test`, role: "ADMIN" },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await db.equipment.deleteMany({ where: { id: { in: devices.splice(0) } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: ids.splice(0) } } });
  await db.equipmentKind.deleteMany({ where: { id: { in: kindIds.splice(0) } } });
  await db.user.delete({ where: { id: admin.id } });
});

describe("shipped model catalog", () => {
  it("skips a linked model moved to another kind without blocking other models", async () => {
    const record = synthetic(),
      pendingRecord = synthetic();
    const linked = await apply(record, 1),
      pending = await model(pendingRecord);
    const computer = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "computer" } });
    await db.equipmentModel.update({
      where: { id: linked.model.id },
      data: { kindId: computer.id, category: "PC" },
    });
    expect(
      (await reconcileModelCatalog({ version: 2, records: [record, pendingRecord] })).changed,
    ).toEqual([pending.id]);
    expect((await getModel(linked.model.id))!.catalogVersion).toBe(1);
  });

  it("does not pick between duplicate installation identities and maps an occupied key to validation", async () => {
    const record = synthetic();
    const first = await model(record),
      second = await model(record, {
        manufacturer: ` ${record.manufacturer.toUpperCase()} `,
        name: record.name.toUpperCase(),
      });
    expect(await reconcileModelCatalog({ version: 1, records: [record] })).toEqual({
      changed: [],
      devices: [],
    });
    await apply(record, 1, first.id);
    await expect(apply(record, 1, second.id)).rejects.toBeInstanceOf(ValidationError);
    expect(await reconcileModelCatalog({ version: 1, records: [record] })).toEqual({
      changed: [],
      devices: [],
    });
    expect((await getModel(second.id))!.catalogKey).toBeNull();
  });

  it("adds both control properties on the version 2 to 3 path and exports only explicit help", async () => {
    await db.customField.deleteMany({
      where: { systemKey: { in: ["projector.control_protocols", "projector.control_systems"] } },
    });
    await db.libraryState.update({ where: { key: "library" }, data: { version: 2 } });
    expect(await reconcileLibrary()).toHaveLength(2);
    const fields = await getFieldSchema("EQUIPMENT");
    for (const key of ["projector.control_protocols", "projector.control_systems"])
      expect(fields.find((field) => field.libraryKey === key)).toMatchObject({
        level: "MODEL",
        type: "MULTI_CHOICE",
        helpText: expect.any(String),
      });
    expect(
      fields.find((field) => field.libraryKey === "projector.light_source")!.helpText,
    ).toBeNull();
  });

  it("rolls back all model and device writes if a catalog update is invalid", async () => {
    const good = synthetic(),
      bad = synthetic();
    const first = await model(good),
      second = await model(bad);
    const unit = await device(first.id);
    await expect(
      reconcileModelCatalog({
        version: 1,
        records: [good, { ...bad, values: { "projector.light_source": "fiction" } }],
      }),
    ).rejects.toThrow();
    for (const entry of [first, second]) expect((await getModel(entry.id))!.catalogKey).toBeNull();
    expect(await db.equipmentPort.count({ where: { equipmentId: unit.id } })).toBe(0);
    expect(
      await db.activityLog.count({ where: { entityId: first.id, action: "CatalogModelLinked" } }),
    ).toBe(0);
  });

  it("validates every property, option, port and manufacturer source of all 140 records", async () => {
    const file = await loadModelCatalog();
    expect(file.records).toHaveLength(140);
    expect(modelCatalogSchema.parse(file)).toEqual(file);
    const epson = file.records.find((record) => record.key === "epson-eb-l1750u")!;
    expect(epson.values).toMatchObject({
      "projector.brightness": 15000,
      "projector.resolution": "1920 × 1200",
      "projector.light_source": "laser",
      "projector.imaging": "3lcd",
      "projector.interchangeable_lens": true,
      weight: 24.1,
    });
    expect(epson.values["projector.control_systems"]).toEqual(
      expect.arrayContaining(["crestron", "extron", "amx"]),
    );
    expect(epson.ports).toHaveLength(12);
    expect(modelCatalogSchema.safeParse({ ...file, records: [epson, epson] }).success).toBe(false);
    for (const invalid of [
      { values: { "projector.light_source": "fiction" } },
      { values: { "projector.projection_mode": "front" } },
      { ports: [{ ...port, connector: "FICTION" }] },
      { sources: [{ url: "https://elsewhere.test", retrievedOn: "2026-11-12" }] },
    ])
      expect(
        modelCatalogSchema.safeParse({ version: 1, records: [{ ...epson, ...invalid }] }).success,
      ).toBe(false);
  });

  it("creates linked models with values, a manual, ports and a write snapshot", async () => {
    const record = synthetic();
    const result = await apply(record, 1);
    const saved = await getModel(result.model.id);
    expect(saved).toMatchObject({
      catalogKey: record.key,
      catalogVersion: 1,
      manualUrl: record.manualUrl,
      name: record.name,
    });
    expect(saved!.ports).toHaveLength(1);
    const raw = await db.equipmentModel.findUniqueOrThrow({ where: { id: result.model.id } });
    expect(raw.catalogSnapshot).toMatchObject({
      values: record.values,
      ports: record.ports,
      name: record.name,
    });
  });

  it("fills only gaps and copies ports only onto devices without ports", async () => {
    const record = synthetic(),
      existing = await model(record);
    await setModelValues(admin, existing.id, { weight: 30 });
    const empty = await device(existing.id),
      edited = await device(existing.id);
    await db.equipmentPort.create({
      data: {
        equipmentId: edited.id,
        label: "House port",
        connector: "VGA",
        direction: "INPUT",
        signal: "VIDEO",
        position: 0,
      },
    });
    await apply(record, 1, existing.id);
    expect(
      (await db.equipmentPort.findMany({ where: { equipmentId: empty.id } }))[0],
    ).toMatchObject(port);
    expect(await db.equipmentPort.findMany({ where: { equipmentId: edited.id } })).toMatchObject([
      { label: "House port" },
    ]);
    const weight = (await getFieldSchema("EQUIPMENT")).find(
      (field) => field.libraryKey === "weight",
    )!;
    expect((await values(existing.id))[weight.id]).toBe(30);
    const raw = await db.equipmentModel.findUniqueOrThrow({ where: { id: existing.id } });
    expect(raw.catalogSnapshot).toMatchObject({ values: { "projector.brightness": 15000 } });
    expect((raw.catalogSnapshot as { values: object }).values).not.toHaveProperty("weight");
    const logs = await db.activityLog.findMany({
      where: { entityId: { in: [existing.id, empty.id] } },
    });
    expect(logs.some((log) => log.action === "CatalogDevicePortsFilled")).toBe(true);
  });

  it("links the existing projector at startup and reuses it when the next device is saved", async () => {
    const catalog = await loadModelCatalog(),
      record = catalog.records.find((record) => record.key === "epson-eb-l1750u")!;
    const existing = await model(record);
    const first = await device(existing.id),
      second = await device(existing.id);
    await reconcileModelCatalog(catalog);
    for (const entry of [first, second]) {
      expect(await db.equipmentPort.count({ where: { equipmentId: entry.id } })).toBe(12);
      const read = (await withFieldValues("EQUIPMENT", [entry]))[0];
      const brightness = (await getFieldSchema("EQUIPMENT")).find(
        (field) => field.libraryKey === "projector.brightness",
      )!;
      expect(read.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: brightness.id, value: 15000, from: "model" }),
        ]),
      );
    }
    const added = await createEquipment(admin, {
      kindId: (await kind()).id,
      modelId: `catalog:${record.key}`,
      mobility: "POOLED",
      status: "OPERATIONAL",
    });
    devices.push(added.id);
    expect(added.modelId).toBe(existing.id);
    expect(
      await db.equipmentModel.count({ where: { manufacturer: "Epson", name: "EB-L1750U" } }),
    ).toBe(1);
    expect(await db.equipmentPort.count({ where: { equipmentId: added.id } })).toBe(12);
    expect(await catalogModelOptions((await kind()).id, "EB-L1750U")).toEqual([]);
    expect((await getModel(existing.id))!.catalogSource).toMatchObject({
      manufacturer: "Epson",
      productUrl: record.productUrl,
    });
    expect(await reconcileModelCatalog(catalog)).toEqual({ changed: [], devices: [] });
  });

  it("matches only unambiguous normalized manufacturer, name and kind", async () => {
    const record = synthetic();
    const exact = await model(record, {
      manufacturer: `  ${record.manufacturer.toUpperCase()} `,
      name: ` ${record.name.toUpperCase()} `,
    });
    const wrong = await model({ ...record, name: "Different" });
    const otherKind = await db.equipmentKind.findUniqueOrThrow({
      where: { systemKey: "computer" },
    });
    const other = await model(
      { ...record, name: "Other kind" },
      { kindId: otherKind.id, category: "PC" },
    );
    const customKind = await db.equipmentKind.create({
      data: { name: `Synthetic ${randomUUID()}`, groupId: (await kind()).groupId, position: 0 },
    });
    kindIds.push(customKind.id);
    const custom = await model({ ...record, name: "Custom kind" }, { kindId: customKind.id });
    const ambiguous = await model({ ...record, name: "Ambiguous" });
    const result = await reconcileModelCatalog({
      version: 1,
      records: [
        record,
        { ...record, name: "Other kind", key: "other-kind" },
        { ...record, name: "Custom kind", key: "custom-kind" },
        { ...record, name: "Ambiguous", key: "ambiguous-a" },
        { ...record, name: "Ambiguous", key: "ambiguous-b" },
      ],
    });
    expect(result.changed).toEqual([exact.id]);
    for (const entry of [wrong, other, custom, ambiguous])
      expect((await getModel(entry.id))!.catalogKey).toBeNull();
  });

  it("rolls back a failed reconcile and keeps application startup running", async () => {
    vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("Synthetic startup failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(register()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("reconcile failed"),
      expect.any(Error),
    );
  });

  it("takes corrections but preserves house values, the manual and changed ports", async () => {
    const record = synthetic(),
      result = await apply(record, 1);
    await setModelValues(admin, result.model.id, { weight: 35 });
    await db.equipmentModel.update({
      where: { id: result.model.id },
      data: { manualUrl: "https://example.test/house" },
    });
    const updated = {
      ...record,
      name: "Corrected model",
      values: { ...record.values, "projector.brightness": 16000, weight: 25 },
      ports: [{ ...port, label: "HDMI 2" }],
    };
    await apply(updated, 2, result.model.id);
    const fields = await getFieldSchema("EQUIPMENT"),
      data = await values(result.model.id);
    expect(data[fields.find((field) => field.libraryKey === "weight")!.id]).toBe(35);
    expect(data[fields.find((field) => field.libraryKey === "projector.brightness")!.id]).toBe(
      16000,
    );
    expect(await getModel(result.model.id)).toMatchObject({
      name: "Corrected model",
      manualUrl: "https://example.test/house",
      ports: [{ label: "HDMI 2" }],
    });
    await setEquipmentModelPorts(admin, result.model.id, [{ ...port, label: "House connector" }]);
    await apply(
      {
        ...updated,
        values: { ...updated.values, weight: 35 },
        manualUrl: "https://example.test/house",
        ports: [port],
      },
      3,
      result.model.id,
    );
    expect((await getModel(result.model.id))!.ports[0].label).toBe("House connector");
    await unlinkCatalogModel(admin, result.model.id);
    const unlinked = await getModel(result.model.id);
    expect(unlinked).toMatchObject({
      catalogKey: null,
      catalogVersion: null,
      manualUrl: "https://example.test/house",
      ports: [{ label: "House connector" }],
    });
    expect(await values(result.model.id)).toEqual({
      [fields.find((field) => field.libraryKey === "weight")!.id]: 35,
    });
  });

  it("unlinks unchanged values and model ports, without removing copied device ports", async () => {
    const record = synthetic(),
      existing = await model(record),
      unit = await device(existing.id);
    await apply(record, 1, existing.id);
    await unlinkCatalogModel(admin, existing.id);
    expect(await getModel(existing.id)).toMatchObject({
      catalogKey: null,
      manualUrl: null,
      ports: [],
      customValues: {},
    });
    expect(await db.equipmentPort.count({ where: { equipmentId: unit.id } })).toBe(1);
  });

  it("keeps every audit row but renders one readable Jiangtang entry per startup step", async () => {
    const time = new Date("1901-01-01T00:00:00Z");
    await txWithAudit(null, async (_tx, audit) => {
      for (let i = 0; i < 37; i++)
        await audit({
          action: "LibraryPropertyReconciled",
          entityType: "customField",
          entityId: `synthetic-${i}`,
          occurredAt: time,
        });
      for (let i = 0; i < 2; i++) {
        await audit({
          action: "CatalogModelLinked",
          entityType: "equipmentModel",
          entityId: `synthetic-${i}`,
          occurredAt: time,
        });
        await audit({
          action: "CatalogDevicePortsFilled",
          entityType: "equipment",
          entityId: `synthetic-${i}`,
          occurredAt: time,
        });
      }
    });
    const feed = await listActivity(admin, {
      cursor: encodeActivityCursor(new Date("1902-01-01T00:00:00Z"), "zz"),
    });
    const steps = feed.items.filter((entry) => +entry.occurredAt === +time);
    expect(steps).toHaveLength(3);
    expect(steps.find((entry) => entry.action === "LibraryPropertyReconciled")).toMatchObject({
      title: "37",
      actorSnapshot: { name: "Jiangtang" },
      href: null,
    });
    expect(await db.activityLog.count({ where: { occurredAt: time } })).toBe(41);
  });
});
