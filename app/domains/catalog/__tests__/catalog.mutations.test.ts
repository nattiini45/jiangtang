import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { ValidationError } from "~/lib/errors.server";
import { createModel, updateModel } from "~/domains/catalog/catalog.mutations.server";

/**
 * Catalog mutation guards: model + audit row commit together; duplicate
 * (manufacturer, name) is rejected. Cleanup deletes the created models only —
 * ActivityLog is append-only (a DELETE would raise 23001).
 */

const RUN = `cat_${Date.now()}`;
const actor = { id: null, name: "Cat Tester", initials: "CT" };
const createdIds: string[] = [];

afterAll(async () => {
  await db.equipmentModel.deleteMany({ where: { id: { in: createdIds } } });
  await db.$disconnect();
});

describe("catalog mutations", () => {
  it("creates a model and writes one ActivityLog row in the same tx", async () => {
    const model = await createModel(actor, {
      manufacturer: `${RUN}-Epson`,
      name: "EB-1485Fi",
      category: "PROJECTOR",
      specNotes: undefined,
      manualUrl: undefined,
    });
    createdIds.push(model.id);
    expect(model.name).toBe("EB-1485Fi");

    const logs = await db.activityLog.findMany({
      where: { entityType: "equipmentModel", entityId: model.id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("EquipmentModelCreated");
    expect(logs[0].actorSnapshot).toMatchObject({ name: "Cat Tester", initials: "CT" });
  });

  it("rejects a duplicate (manufacturer, name)", async () => {
    const input = {
      manufacturer: `${RUN}-Sennheiser`,
      name: "EW 100 G4",
      category: "MICROPHONE",
      specNotes: undefined,
      manualUrl: undefined,
    } as const;
    const first = await createModel(actor, { ...input });
    createdIds.push(first.id);
    await expect(createModel(actor, { ...input })).rejects.toBeInstanceOf(ValidationError);
  });

  it("updates a model and audits it", async () => {
    const model = await createModel(actor, {
      manufacturer: `${RUN}-Dell`,
      name: "OptiPlex",
      category: "PC",
      specNotes: undefined,
      manualUrl: undefined,
    });
    createdIds.push(model.id);

    const updated = await updateModel(actor, model.id, {
      manufacturer: `${RUN}-Dell`,
      name: "OptiPlex 7010",
      category: "PC",
      specNotes: "i7, 16 GB",
      manualUrl: undefined,
    });
    expect(updated.name).toBe("OptiPlex 7010");

    const logs = await db.activityLog.findMany({
      where: { entityType: "equipmentModel", entityId: model.id, action: "EquipmentModelUpdated" },
    });
    expect(logs).toHaveLength(1);
  });
});
