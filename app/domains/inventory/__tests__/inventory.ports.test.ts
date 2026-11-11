import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { setEquipmentModelPorts } from "~/domains/catalog/catalog.ports.mutations.server";
import {
  createEquipment,
  bulkCreateEquipment,
} from "~/domains/inventory/inventory.mutations.server";
import { equipmentCreateSchema, equipmentCsvRowSchema } from "~/domains/inventory/inventory.schema";
import { mutateEquipmentPort } from "~/domains/inventory/inventory.ports.mutations.server";
import { getEquipment } from "~/domains/inventory/inventory.queries.server";
import { getModel } from "~/domains/catalog/catalog.queries.server";
import { modelPortsSchema, type PortInput } from "~/domains/inventory/inventory.ports.schema";

const prefix = `ports-${Date.now()}`;
const actor = { id: null, name: "Synthetic port tester" };
const models: string[] = [];
const equipment: string[] = [];
const port: PortInput = {
  label: "HDMI OUT",
  connector: "HDMI",
  direction: "OUTPUT",
  signal: "VIDEO",
  position: 0,
};
async function fixture() {
  const model = await db.equipmentModel.create({
    data: { name: `${prefix}-${models.length}`, category: "PROJECTOR" },
  });
  models.push(model.id);
  await setEquipmentModelPorts(actor, model.id, [port]);
  const unit = await createEquipment(
    actor,
    equipmentCreateSchema.parse({ modelId: model.id, category: "PROJECTOR", mobility: "POOLED" }),
  );
  equipment.push(unit.id);
  return { model, unit };
}
afterAll(async () => {
  await db.equipment.deleteMany({ where: { id: { in: equipment } } });
  await db.equipmentModel.deleteMany({ where: { id: { in: models } } });
  await db.$disconnect();
});

describe("equipment ports", () => {
  it("copies templates at creation and keeps existing devices unchanged", async () => {
    const { model, unit } = await fixture();
    const original = (await getEquipment(unit.id))!.ports[0];
    expect(original).toMatchObject({
      ...port,
      modelPortId: (await getModel(model.id))!.ports[0].id,
    });
    await setEquipmentModelPorts(actor, model.id, [
      { ...port, connector: "DISPLAYPORT" },
      { ...port, label: "Audio", connector: "XLR", signal: "AUDIO" },
    ]);
    expect((await getEquipment(unit.id))!.ports).toEqual([original]);
    await mutateEquipmentPort(actor, unit.id, "inherit");
    await mutateEquipmentPort(actor, unit.id, "inherit");
    expect((await getEquipment(unit.id))!.ports.map((p) => [p.label, p.connector])).toEqual([
      ["HDMI OUT", "HDMI"],
      ["Audio", "XLR"],
    ]);
    await setEquipmentModelPorts(actor, model.id, []);
    expect((await getEquipment(unit.id))!.ports).toHaveLength(2);
    expect((await getEquipment(unit.id))!.ports.every((p) => p.modelPortId === null)).toBe(true);
  });

  it("supports device ports, edits, deletion and parent-scoped IDs", async () => {
    const { unit } = await fixture();
    const result = await mutateEquipmentPort(actor, unit.id, "add", {
      ...port,
      label: "USB",
      connector: "USB_C",
      note: "Synthetic note",
      position: 2,
    });
    await mutateEquipmentPort(
      actor,
      unit.id,
      "update",
      { ...port, label: "USB", connector: "USB_C", note: "Changed", position: 1 },
      result.id,
    );
    expect((await getEquipment(unit.id))!.ports[1]).toMatchObject({ note: "Changed", position: 1 });
    const other = await fixture();
    await expect(
      mutateEquipmentPort(actor, other.unit.id, "remove", undefined, result.id),
    ).rejects.toMatchObject({ name: "NotFoundError" });
    await mutateEquipmentPort(actor, unit.id, "remove", undefined, result.id);
    expect((await getEquipment(unit.id))!.ports).toHaveLength(1);
    expect(
      await db.activityLog.count({
        where: { entityId: unit.id, action: { startsWith: "EquipmentPort" } },
      }),
    ).toBe(3);
  });

  it("enforces unique labels in PostgreSQL and validates connectors", async () => {
    const { model, unit } = await fixture();
    const original = (await getEquipment(unit.id))!.ports[0];
    await expect(
      db.equipmentPort.create({ data: { ...port, equipmentId: unit.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      db.equipmentModelPort.create({ data: { ...port, modelId: model.id } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(mutateEquipmentPort(actor, unit.id, "add", port)).rejects.toMatchObject({
      name: "ValidationError",
    });
    expect(modelPortsSchema.safeParse([port, port]).success).toBe(false);
    expect(modelPortsSchema.safeParse([{ ...port, connector: "invalid" }]).success).toBe(false);
    const extra = await mutateEquipmentPort(actor, unit.id, "add", { ...port, label: "Extra" });
    await expect(
      mutateEquipmentPort(actor, unit.id, "update", port, extra.id),
    ).rejects.toMatchObject({ name: "ValidationError" });
    expect((await getEquipment(unit.id))!.ports[0]).toEqual(original);
    await mutateEquipmentPort(actor, unit.id, "remove", undefined, extra.id);
    expect((await getEquipment(unit.id))!.ports).toHaveLength(1);
  });

  it("copies model ports for CSV equipment imports too", async () => {
    const { model } = await fixture();
    const result = await bulkCreateEquipment(actor, [
      equipmentCsvRowSchema.parse({
        kategorie: "PROJECTOR",
        mobilitaet: "POOLED",
        modell: model.name,
      }),
    ]);
    equipment.push(result.items[0].id);
    expect((await getEquipment(result.items[0].id))!.ports).toHaveLength(1);
  });
});
