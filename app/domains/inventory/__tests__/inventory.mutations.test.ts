import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import {
  createEquipment,
  retireEquipment,
  setSubstitution,
} from "~/domains/inventory/inventory.mutations.server";
import type { EquipmentCreateInput } from "~/domains/inventory/inventory.schema";

const RUN = `eq_${Date.now()}`;
const actor = { id: null, name: "Eq Tester", initials: "ET" };
const ids = { campus: `${RUN}_c`, room: `${RUN}_r` };
const createdEquipmentIds: string[] = [];

beforeAll(async () => {
  await db.campus.create({ data: { id: ids.campus, name: ids.campus, slug: ids.campus } });
  await db.room.create({
    data: { id: ids.room, slug: ids.room, name: "EqRoom", campusId: ids.campus },
  });
});

afterAll(async () => {
  await db.equipment.deleteMany({ where: { id: { in: createdEquipmentIds } } });
  await db.room.deleteMany({ where: { id: ids.room } });
  await db.campus.deleteMany({ where: { id: ids.campus } });
  await db.$disconnect();
});

function eqInput(
  over: Partial<EquipmentCreateInput> & { category: EquipmentCreateInput["category"] },
): EquipmentCreateInput {
  return {
    modelId: undefined,
    roomId: undefined,
    mobility: "FIXED",
    status: "OPERATIONAL",
    name: undefined,
    assetTag: undefined,
    serial: undefined,
    hostname: undefined,
    ipAddress: undefined,
    macAddress: undefined,
    dellServiceTag: undefined,
    dellExpressTag: undefined,
    micKind: undefined,
    frequencyMhz: undefined,
    band: undefined,
    channelLabel: undefined,
    lampType: undefined,
    lastLampChangeAt: undefined,
    color: undefined,
    attributes: undefined,
    ...over,
  };
}

describe("equipment mutations", () => {
  it("creates a FIXED unit in a room with one audit row", async () => {
    const eq = await createEquipment(
      actor,
      eqInput({ category: "PROJECTOR", roomId: ids.room, name: `${RUN} Beamer` }),
    );
    createdEquipmentIds.push(eq.id);
    expect(eq.roomId).toBe(ids.room);
    expect(eq.mobility).toBe("FIXED");
    const logs = await db.activityLog.findMany({
      where: { entityType: "equipment", entityId: eq.id, action: "EquipmentCreated" },
    });
    expect(logs).toHaveLength(1);
  });

  it("creates a POOLED unit with no room", async () => {
    const eq = await createEquipment(
      actor,
      eqInput({ category: "MICROPHONE", mobility: "POOLED", name: `${RUN} Funkmic` }),
    );
    createdEquipmentIds.push(eq.id);
    expect(eq.roomId).toBeNull();
  });

  it("retires a unit without deleting it", async () => {
    const eq = await createEquipment(
      actor,
      eqInput({ category: "PC", roomId: ids.room, name: `${RUN} PC` }),
    );
    createdEquipmentIds.push(eq.id);
    const retired = await retireEquipment(actor, eq.id);
    expect(retired.status).toBe("RETIRED");
    const still = await db.equipment.findUnique({ where: { id: eq.id } });
    expect(still).not.toBeNull();
  });

  // Retiring a unit that's part of an active substitution must clear BOTH
  // directions of the link so no active substitution ever references a RETIRED unit.
  it("clears the substitution link when the spare itself is retired", async () => {
    const faulty = await createEquipment(
      actor,
      eqInput({
        category: "PROJECTOR",
        roomId: ids.room,
        status: "FAULTY",
        name: `${RUN} f-spare-retire`,
      }),
    );
    const spare = await createEquipment(
      actor,
      eqInput({ category: "PROJECTOR", mobility: "POOLED", name: `${RUN} spare-retire` }),
    );
    createdEquipmentIds.push(faulty.id, spare.id);

    await setSubstitution(actor, { spareId: spare.id, faultyId: faulty.id });
    const retiredSpare = await retireEquipment(actor, spare.id);
    expect(retiredSpare.status).toBe("RETIRED");
    expect(retiredSpare.substitutingForId).toBeNull();
  });

  it("clears the substitution link when the faulty (substituted-for) unit is retired", async () => {
    const faulty = await createEquipment(
      actor,
      eqInput({
        category: "PROJECTOR",
        roomId: ids.room,
        status: "FAULTY",
        name: `${RUN} f-faulty-retire`,
      }),
    );
    const spare = await createEquipment(
      actor,
      eqInput({ category: "PROJECTOR", mobility: "POOLED", name: `${RUN} spare-faulty-retire` }),
    );
    createdEquipmentIds.push(faulty.id, spare.id);

    await setSubstitution(actor, { spareId: spare.id, faultyId: faulty.id });
    await retireEquipment(actor, faulty.id);

    const spareAfter = await db.equipment.findUnique({ where: { id: spare.id } });
    expect(spareAfter?.substitutingForId).toBeNull();
  });
});
