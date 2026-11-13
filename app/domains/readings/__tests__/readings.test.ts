import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "~/lib/db.server";
import { reconcileLibrary } from "~/lib/custom-fields/library.server";
import { getFieldSchema } from "~/lib/custom-fields/schema.server";
import { recordReading, appendReadingInTx } from "../readings.mutations.server";
import { dueReadings, getDeviceReadings, readingDevices } from "../readings.queries.server";
import { readingDue, readingRules } from "../readings.policy";
import { libraryProperties } from "~/lib/equipment-kinds/properties";
import {
  addPartStock,
  takePartForDevice,
} from "~/domains/inventory/inventory.parts.mutations.server";
import { startRound } from "~/domains/functions/rounds.mutations.server";
import type { AuditActor } from "~/lib/audit.server";
import { readConfig } from "~/lib/config.server";
import { txWithAudit } from "~/lib/audit.server";

let actor: AuditActor,
  equipmentId: string,
  secondId: string,
  roomId: string,
  fieldId: string,
  filterFieldId: string,
  filterId: string,
  stockId: string,
  roundId: string;
let hostModelId: string, addedKindId: string | undefined;
let baselineFields: string[] = [];
const observedAt = new Date("2025-01-03T10:00:00Z");
beforeAll(async () => {
  await reconcileLibrary();
  baselineFields = (await db.customField.findMany({ select: { id: true } })).map(
    (field) => field.id,
  );
  actor = await db.user.create({
    data: {
      id: randomUUID(),
      name: "Synthetic reading editor",
      email: `${randomUUID()}@example.test`,
      role: "ADMIN",
      isActive: true,
    },
  });
  const projector = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  let filterKind = await db.equipmentKind.findUnique({ where: { systemKey: "projector_filter" } });
  if (!filterKind) {
    filterKind = await db.equipmentKind.create({
      data: {
        name: "Synthetic filter kind",
        systemKey: "projector_filter",
        groupId: projector.groupId,
        position: 100,
      },
    });
    addedKindId = filterKind.id;
  }
  await reconcileLibrary();
  const fields = await getFieldSchema("EQUIPMENT");
  const life = fields.find((field) => field.libraryKey === "projector.light_source_life")!;
  const lightSource = fields.find((field) => field.libraryKey === "projector.light_source")!;
  const model = await db.equipmentModel.create({
    data: {
      name: randomUUID(),
      category: "PROJECTOR",
      kindId: projector.id,
      customValues: {
        [life.id]: 20000,
        [lightSource.id]: lightSource.options.find((option) => option.systemKey === "laser")!.id,
      },
    },
  });
  hostModelId = model.id;
  filterId = (
    await db.equipmentModel.create({
      data: { name: randomUUID(), category: "OTHER", kindId: filterKind.id },
    })
  ).id;
  await db.modelPartFit.create({ data: { modelId: model.id, partModelId: filterId } });
  roomId = (await db.room.create({ data: { name: "Synthetic readings room", slug: randomUUID() } }))
    .id;
  for (const index of [0, 1]) {
    const device = await db.equipment.create({
      data: {
        name: `Synthetic readings ${randomUUID()}`,
        kindId: model.kindId,
        modelId: model.id,
        roomId,
        category: "PROJECTOR",
      },
    });
    if (index === 0) equipmentId = device.id;
    else secondId = device.id;
  }
  const measures = await getFieldSchema("EQUIPMENT", { kindId: model.kindId, store: "READING" });
  fieldId = measures.find((field) => field.libraryKey === "projector.light_source_hours")!.id;
  filterFieldId = measures.find((field) => field.libraryKey === "projector.filter_hours")!.id;
  stockId = (await addPartStock(actor, filterId, 2)).id;
});
afterAll(async () => {
  await db.$executeRaw`TRUNCATE "EquipmentReading"`;
  if (roundId) {
    await db.roomCheck.deleteMany({ where: { roundId } });
    await db.roundRoom.deleteMany({ where: { roundId } });
    await db.round.delete({ where: { id: roundId } });
  }
  if (stockId) await db.inventoryItem.delete({ where: { id: stockId } });
  await db.equipment.deleteMany({ where: { id: { in: [equipmentId, secondId].filter(Boolean) } } });
  if (roomId) await db.room.delete({ where: { id: roomId } });
  if (hostModelId) await db.modelPartFit.deleteMany({ where: { modelId: hostModelId } });
  await db.equipmentModel.deleteMany({
    where: { id: { in: [hostModelId, filterId].filter(Boolean) } },
  });
  if (addedKindId) {
    await db.customFieldKind.deleteMany({ where: { kindId: addedKindId } });
    await db.customField.deleteMany({
      where: { id: { notIn: baselineFields }, kinds: { none: {} } },
    });
    await db.equipmentKind.delete({ where: { id: addedKindId } });
  }
  if (actor?.id) await db.user.delete({ where: { id: actor.id } });
});

describe("dated, sourced readings", () => {
  it("records battery health as a percentage without inventing a replacement threshold", async () => {
    const before = (await db.customField.findMany({ select: { id: true } })).map(
      (field) => field.id,
    );
    const group = await db.equipmentFunctionGroup.findFirstOrThrow();
    const existing = await db.equipmentKind.findUnique({
      where: { systemKey: "wireless_battery" },
    });
    const kind =
      existing ??
      (await db.equipmentKind.create({
        data: {
          name: "Synthetic battery kind",
          systemKey: "wireless_battery",
          groupId: group.id,
          position: 100,
        },
      }));
    await reconcileLibrary();
    const device = await db.equipment.create({
      data: { name: "Synthetic battery", category: "OTHER", kindId: kind.id },
    });
    try {
      const fields = await getFieldSchema("EQUIPMENT", { store: "READING", kindId: kind.id });
      const health = fields.find((field) => field.libraryKey === "wireless_battery.health")!;
      await recordReading(actor, {
        equipmentId: device.id,
        fieldId: health.id,
        value: 81,
        observedAt,
      });
      await expect(
        recordReading(actor, {
          equipmentId: device.id,
          fieldId: health.id,
          value: 101,
          observedAt,
        }),
      ).rejects.toThrow();
      expect(
        (await getDeviceReadings(device.id)).device.measures.find(
          (measure) => measure.id === health.id,
        ),
      ).toMatchObject({ unit: "%", state: "unknown", latest: { value: 81 } });
    } finally {
      await db.$executeRaw`TRUNCATE "EquipmentReading"`;
      await db.equipment.delete({ where: { id: device.id } });
      if (!existing) {
        await db.customFieldKind.deleteMany({ where: { kindId: kind.id } });
        await db.roomFunctionKind.deleteMany({ where: { kindId: kind.id } });
        await db.equipmentKind.delete({ where: { id: kind.id } });
        await db.customField.deleteMany({ where: { id: { notIn: before }, kinds: { none: {} } } });
      }
    }
  });
  it("rolls back a reading and its audit when the transaction fails", async () => {
    const count = await db.equipmentReading.count();
    const auditCount = await db.activityLog.count({ where: { entityId: equipmentId } });
    await expect(
      txWithAudit(actor, async (tx, audit) => {
        await appendReadingInTx(tx, audit, actor, {
          equipmentId,
          fieldId,
          value: 10,
          observedAt,
          source: "typed",
        });
        throw new Error("Synthetic transaction failure");
      }),
    ).rejects.toThrow("Synthetic transaction failure");
    expect(await db.equipmentReading.count()).toBe(count);
    expect(await db.activityLog.count({ where: { entityId: equipmentId } })).toBe(auditCount);
  });
  it("uses exact rated-life boundaries and never invents missing values", () => {
    for (const [key, rule] of Object.entries(readingRules)) {
      expect(libraryProperties.get(key)?.store).toBe("READING");
      for (const limit of rule.limits)
        expect(libraryProperties.get(limit)).toMatchObject({ type: "NUMBER", unit: "h" });
    }
    expect(readConfig("READING_DUE_MARGIN_PERCENT", { READING_DUE_MARGIN_PERCENT: "5" })).toBe(5);
    expect(readConfig("READING_DUE_MARGIN_PERCENT", { READING_DUE_MARGIN_PERCENT: "0" })).toBe(0);
    for (const value of ["-1", "101", "NaN", "Infinity"])
      expect(readConfig("READING_DUE_MARGIN_PERCENT", { READING_DUE_MARGIN_PERCENT: value })).toBe(
        10,
      );
    expect(readingDue(null, 20000, 10)).toBe("unknown");
    expect(readingDue(18500, null, 10)).toBe("unknown");
    expect(readingDue(17999, 20000, 10)).toBe("ok");
    expect(readingDue(18000, 20000, 10)).toBe("soon");
    expect(readingDue(20000, 20000, 10)).toBe("due");
    expect(readingDue(18500, 20000, 5)).toBe("ok");
  });
  it("appends a fact and its audit atomically without treating it as an ordinary field", async () => {
    const row = await recordReading(actor, { equipmentId, fieldId, observedAt, value: 18500 });
    expect(row).toMatchObject({ value: 18500, source: "typed", recordedById: actor.id });
    expect(
      await db.activityLog.count({
        where: {
          entityId: equipmentId,
          action: "EquipmentReadingRecorded",
          data: { path: ["readingId"], equals: row.id },
        },
      }),
    ).toBe(1);
    const device = (await readingDevices({ id: equipmentId }, new Date("2026-11-01T12:00:00Z")))[0];
    expect(device.measures.find((measure) => measure.id === fieldId)).toMatchObject({
      state: "soon",
      stale: true,
      limit: 20000,
    });
    expect(device.parts.find((part) => part.id === filterId)?.count).toBeGreaterThanOrEqual(2);
    expect((await getFieldSchema("EQUIPMENT")).some((field) => field.id === fieldId)).toBe(false);
    expect(
      (await db.equipment.findUniqueOrThrow({ where: { id: equipmentId } })).customValues,
    ).toEqual({});
    await expect(
      db.equipmentReading.update({ where: { id: row.id }, data: { value: 1 } }),
    ).rejects.toThrow();
    await expect(db.equipmentReading.delete({ where: { id: row.id } })).rejects.toThrow();
  });
  it("keeps observed time, not insertion order, authoritative and preserves corrections", async () => {
    await recordReading(actor, {
      equipmentId,
      fieldId,
      observedAt: new Date("2024-01-01T00:00:00Z"),
      value: 100,
    });
    expect(
      (await getDeviceReadings(equipmentId)).device.measures.find(
        (measure) => measure.id === fieldId,
      )?.latest?.value,
    ).toBe(18500);
    await recordReading(actor, { equipmentId, fieldId, observedAt, value: 19000 });
    expect(
      (await getDeviceReadings(equipmentId, true)).history.filter((row) => row.fieldId === fieldId),
    ).toHaveLength(3);
    expect(
      (await getDeviceReadings(equipmentId)).device.measures.find(
        (measure) => measure.id === fieldId,
      )?.latest?.value,
    ).toBe(19000);
  });
  it("refuses inapplicable measures, future dates, bad values and inactive actors without a reading or audit", async () => {
    const base = { equipmentId, fieldId, observedAt, value: 20000 };
    const count = await db.equipmentReading.count();
    const audits = await db.activityLog.count({ where: { entityId: equipmentId } });
    for (const patch of [
      { value: -1 },
      { value: "18500" },
      { fieldId: "missing" },
      { observedAt: new Date("2999-01-01T00:00:00Z") },
      { roundId: "missing" },
    ])
      await expect(recordReading(actor, { ...base, ...patch })).rejects.toThrow();
    await expect(
      recordReading({ name: "Synthetic unauthorized actor" }, base),
    ).rejects.toBeInstanceOf(Response);
    expect(await db.equipmentReading.count()).toBe(count);
    expect(await db.activityLog.count({ where: { entityId: equipmentId } })).toBe(audits);
  });
  it("records provenance only for a device in the round and allows optional readings after the final check closes it", async () => {
    roundId = (await startRound(actor, { name: "Synthetic reading round", roomIds: [roomId] })).id;
    const reading = await recordReading(actor, {
      equipmentId,
      fieldId: filterFieldId,
      observedAt,
      value: 900,
      roundId,
    });
    expect(reading).toMatchObject({ source: "round", sourceRef: roundId });
    await db.round.update({ where: { id: roundId }, data: { closedAt: new Date() } });
    await recordReading(actor, {
      equipmentId,
      fieldId: filterFieldId,
      observedAt,
      value: 900,
      roundId,
    });
    expect((await db.round.findUniqueOrThrow({ where: { id: roundId } })).closedAt).not.toBeNull();
    await db.equipment.update({ where: { id: secondId }, data: { roomId: null } });
    await expect(
      recordReading(actor, { equipmentId: secondId, fieldId, observedAt, value: 1, roundId }),
    ).rejects.toThrow();
    await db.equipment.update({ where: { id: secondId }, data: { roomId } });
  });
  it("uses a part's explicitly recorded interval and resets only its own counter with stock consumption", async () => {
    const interval = (await getFieldSchema("EQUIPMENT")).find(
      (field) => field.libraryKey === "projector_filter.service_interval",
    )!;
    const part = await db.equipmentModel.findUniqueOrThrow({ where: { id: filterId } });
    await db.equipmentModel.update({
      where: { id: filterId },
      data: { customValues: { [interval.id]: 1000 } },
    });
    try {
      expect(
        (await readingDevices({ id: equipmentId }))[0].measures.find(
          (measure) => measure.id === filterFieldId,
        ),
      ).toMatchObject({ limit: 1000, state: "soon" });
      await takePartForDevice(actor, equipmentId, stockId, true);
      const device = (await getDeviceReadings(equipmentId)).device;
      expect(device.measures.find((measure) => measure.id === filterFieldId)?.latest).toMatchObject(
        { value: 0, source: "replacement", sourceRef: stockId, partModelId: filterId },
      );
      expect(device.measures.find((measure) => measure.id === fieldId)?.latest?.value).toBe(19000);
      expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: stockId } })).quantity).toBe(
        1,
      );
      await takePartForDevice(actor, equipmentId, stockId, true);
      const count = await db.equipmentReading.count();
      await expect(takePartForDevice(actor, equipmentId, stockId, true)).rejects.toThrow();
      expect(await db.equipmentReading.count()).toBe(count);
    } finally {
      await db.equipmentModel.update({
        where: { id: filterId },
        data: { customValues: part.customValues! },
      });
    }
  });
  it("prioritizes stale readings, then the most overdue device and retains retired history", async () => {
    await recordReading(actor, {
      equipmentId: secondId,
      fieldId,
      observedAt: new Date("2026-10-01T00:00:00Z"),
      value: 22000,
    });
    const rows = (await dueReadings(new Date("2026-11-01T12:00:00Z"))).filter((row) =>
      [equipmentId, secondId].includes(row.deviceId),
    );
    expect(rows.map((row) => row.deviceId)).toEqual([equipmentId, secondId]);
    await db.equipment.update({ where: { id: secondId }, data: { status: "RETIRED" } });
    expect((await getDeviceReadings(secondId, true)).history).toHaveLength(1);
    expect((await dueReadings()).some((row) => row.deviceId === secondId)).toBe(false);
  });
});
