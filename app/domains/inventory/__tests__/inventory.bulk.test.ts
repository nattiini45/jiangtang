import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { bulkCreateEquipment } from "~/domains/inventory/inventory.mutations.server";
import { equipmentCsvRowSchema } from "~/domains/inventory/inventory.schema";

const run = `equipment-bulk-${crypto.randomUUID()}`;
const actor = { id: null, name: "Synthetic equipment importer" };

afterAll(async () => {
  await db.equipment.deleteMany({ where: { assetTag: { startsWith: run } } });
});

describe("bulk equipment results", () => {
  it("returns actual committed IDs and labels while preserving the count", async () => {
    const result = await bulkCreateEquipment(actor, [
      equipmentCsvRowSchema.parse({
        kategorie: "OTHER",
        mobilitaet: "POOLED",
        name: "Synthetic unit",
        inventarnr: `${run}-named`,
      }),
      equipmentCsvRowSchema.parse({
        kategorie: "MICROPHONE",
        mobilitaet: "POOLED",
        inventarnr: `${run}-unnamed`,
      }),
    ]);
    expect(result.created).toBe(2);
    expect(result.items).toEqual([
      {
        id: expect.any(String),
        name: "Synthetic unit",
        category: "OTHER",
        assetTag: `${run}-named`,
      },
      { id: expect.any(String), name: null, category: "MICROPHONE", assetTag: `${run}-unnamed` },
    ]);
    expect(new Set(result.items.map((item) => item.id)).size).toBe(2);
    for (const item of result.items) {
      expect(
        await db.equipment.findUnique({
          where: { id: item.id },
          select: { id: true, name: true, category: true, assetTag: true },
        }),
      ).toEqual(item);
      expect(
        await db.activityLog.count({
          where: { entityType: "equipment", entityId: item.id, action: "EquipmentCreated" },
        }),
      ).toBe(1);
    }
  });

  it("does not leak the successful first row when a later row fails", async () => {
    await expect(
      bulkCreateEquipment(actor, [
        equipmentCsvRowSchema.parse({
          kategorie: "OTHER",
          mobilitaet: "POOLED",
          inventarnr: `${run}-rollback`,
        }),
        equipmentCsvRowSchema.parse({ kategorie: "OTHER", mobilitaet: "FIXED" }),
      ]),
    ).rejects.toThrow();
    expect(await db.equipment.count({ where: { assetTag: `${run}-rollback` } })).toBe(0);
  });
});
