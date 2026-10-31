import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { createEquipment, setSubstitution } from "~/domains/inventory/inventory.mutations.server";
import { ValidationError } from "~/lib/errors.server";
import type { EquipmentCreateInput } from "~/domains/inventory/inventory.schema";

const RUN = `sub_${Date.now()}`;
const actor = { id: null, name: "Sub Tester", initials: "ST" };
const ids = { campus: `${RUN}_c`, room: `${RUN}_r` };
const createdEquipmentIds: string[] = [];

beforeAll(async () => {
  await db.campus.create({ data: { id: ids.campus, name: ids.campus, slug: ids.campus } });
  await db.room.create({
    data: { id: ids.room, slug: ids.room, name: "SubRoom", campusId: ids.campus },
  });
});

afterAll(async () => {
  // Drop substitution links first so deletes don't trip the self-relation FK.
  await db.equipment.updateMany({
    where: { id: { in: createdEquipmentIds } },
    data: { substitutingForId: null },
  });
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

describe("equipment substitution", () => {
  it("sets and clears a spare → faulty substitution", async () => {
    const faulty = await createEquipment(
      actor,
      eqInput({ category: "PROJECTOR", roomId: ids.room, status: "FAULTY", name: `${RUN} faulty` }),
    );
    const spare = await createEquipment(
      actor,
      eqInput({ category: "PROJECTOR", mobility: "POOLED", name: `${RUN} spare` }),
    );
    createdEquipmentIds.push(faulty.id, spare.id);

    const set = await setSubstitution(actor, { spareId: spare.id, faultyId: faulty.id });
    expect(set.substitutingForId).toBe(faulty.id);

    const cleared = await setSubstitution(actor, { spareId: spare.id, clear: true });
    expect(cleared.substitutingForId).toBeNull();
  });

  it("rejects self-substitution", async () => {
    const e = await createEquipment(
      actor,
      eqInput({ category: "PC", roomId: ids.room, name: `${RUN} self` }),
    );
    createdEquipmentIds.push(e.id);
    await expect(setSubstitution(actor, { spareId: e.id, faultyId: e.id })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects substituting a RETIRED unit", async () => {
    const retired = await createEquipment(
      actor,
      eqInput({ category: "PC", roomId: ids.room, status: "RETIRED", name: `${RUN} ret` }),
    );
    const spare = await createEquipment(
      actor,
      eqInput({ category: "PC", mobility: "POOLED", name: `${RUN} sp2` }),
    );
    createdEquipmentIds.push(retired.id, spare.id);
    await expect(
      setSubstitution(actor, { spareId: spare.id, faultyId: retired.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects two spares for the same faulty unit (substitutingForId @unique)", async () => {
    const faulty = await createEquipment(
      actor,
      eqInput({ category: "AUDIO", roomId: ids.room, status: "FAULTY", name: `${RUN} f2` }),
    );
    const s1 = await createEquipment(
      actor,
      eqInput({ category: "AUDIO", mobility: "POOLED", name: `${RUN} s1` }),
    );
    const s2 = await createEquipment(
      actor,
      eqInput({ category: "AUDIO", mobility: "POOLED", name: `${RUN} s2` }),
    );
    createdEquipmentIds.push(faulty.id, s1.id, s2.id);

    await setSubstitution(actor, { spareId: s1.id, faultyId: faulty.id });
    await expect(
      setSubstitution(actor, { spareId: s2.id, faultyId: faulty.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  // A RETIRED (or FAULTY) unit can't stand in as the spare, even though it
  // was already accepted as a valid *faulty* target check.
  it("rejects a RETIRED unit as the spare", async () => {
    const faulty = await createEquipment(
      actor,
      eqInput({ category: "PC", roomId: ids.room, status: "FAULTY", name: `${RUN} f3` }),
    );
    const retiredSpare = await createEquipment(
      actor,
      eqInput({ category: "PC", mobility: "POOLED", status: "RETIRED", name: `${RUN} rs` }),
    );
    createdEquipmentIds.push(faulty.id, retiredSpare.id);
    await expect(
      setSubstitution(actor, { spareId: retiredSpare.id, faultyId: faulty.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a FAULTY unit as the spare", async () => {
    const faulty = await createEquipment(
      actor,
      eqInput({ category: "PC", roomId: ids.room, status: "FAULTY", name: `${RUN} f4` }),
    );
    const faultySpare = await createEquipment(
      actor,
      eqInput({ category: "PC", mobility: "POOLED", status: "FAULTY", name: `${RUN} fs` }),
    );
    createdEquipmentIds.push(faulty.id, faultySpare.id);
    await expect(
      setSubstitution(actor, { spareId: faultySpare.id, faultyId: faulty.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
