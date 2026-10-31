import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { cloneRoom } from "~/domains/rooms/rooms.mutations.server";
import type { RoomCloneInput } from "~/domains/rooms/rooms.schema";

/**
 * Clone copies the chosen setup, recreates FIXED gear as fresh units (asset
 * tag / serial nulled), skips POOLED gear, and audits — all in one tx.
 */

const RUN = `clone_${Date.now()}`;
const actor = { id: null, name: "Clone Tester", initials: "CL" };
const ids = {
  campus: `${RUN}_c`,
  source: `${RUN}_src`,
  fixed: `${RUN}_fx`,
  pooled: `${RUN}_pl`,
  faulty: `${RUN}_ft`,
};
const createdRoomIds: string[] = [ids.source];

beforeAll(async () => {
  await db.campus.create({ data: { id: ids.campus, name: ids.campus, slug: ids.campus } });
  await db.room.create({
    data: {
      id: ids.source,
      slug: ids.source,
      name: "Source Hall",
      campusId: ids.campus,
      hasProjector: true,
      videoInputs: ["HDMI", "USB-C"],
      tipsNotes: "Beamer-Fernbedienung im Pult.",
    },
  });
  await db.equipment.create({
    data: {
      id: ids.fixed,
      roomId: ids.source,
      category: "PROJECTOR",
      mobility: "FIXED",
      name: "Beamer",
      assetTag: "INV-1",
      serial: "SN-1",
    },
  });
  await db.equipment.create({
    data: { id: ids.pooled, category: "MICROPHONE", mobility: "POOLED", name: "Funkmic" },
  });
  // A FIXED unit that is NOT operational — clone must preserve this, not upgrade it.
  await db.equipment.create({
    data: {
      id: ids.faulty,
      roomId: ids.source,
      category: "MICROPHONE",
      mobility: "FIXED",
      status: "FAULTY",
      name: "Defektes Mic",
    },
  });
});

afterAll(async () => {
  await db.equipment.deleteMany({
    where: { OR: [{ roomId: { in: createdRoomIds } }, { id: ids.pooled }] },
  });
  await db.room.deleteMany({ where: { id: { in: createdRoomIds } } });
  await db.campus.deleteMany({ where: { id: ids.campus } });
  await db.$disconnect();
});

function cloneInput(over: Partial<RoomCloneInput> & { name: string }): RoomCloneInput {
  return {
    roomNumber: undefined,
    campusId: ids.campus,
    newCampusName: undefined,
    buildingId: undefined,
    newBuildingName: undefined,
    copyFeatures: true,
    copyCapabilities: true,
    copyTips: false,
    copyEquipment: true,
    ...over,
  };
}

describe("cloneRoom", () => {
  it("clones setup + FIXED gear (nulled identifiers), skips POOLED, audits", async () => {
    const clone = await cloneRoom(actor, ids.source, cloneInput({ name: `${RUN} Clone` }));
    createdRoomIds.push(clone.id);

    expect(clone.slug).not.toBe(ids.source);
    expect(clone.hasProjector).toBe(true);
    expect(clone.videoInputs).toEqual(["HDMI", "USB-C"]);
    expect(clone.tipsNotes).toBeNull(); // copyTips: false

    const gear = await db.equipment.findMany({
      where: { roomId: clone.id },
      orderBy: { category: "asc" },
    });
    expect(gear).toHaveLength(2); // POOLED skipped, 2 FIXED units copied

    const beamer = gear.find((g) => g.category === "PROJECTOR");
    expect(beamer?.name).toBe("Beamer");
    expect(beamer?.assetTag).toBeNull();
    expect(beamer?.serial).toBeNull();
    // The source unit was OPERATIONAL (default); the clone preserves that.
    expect(beamer?.status).toBe("OPERATIONAL");

    // A FAULTY source unit must clone as FAULTY, not silently upgraded.
    const mic = gear.find((g) => g.category === "MICROPHONE");
    expect(mic?.name).toBe("Defektes Mic");
    expect(mic?.status).toBe("FAULTY");

    const logs = await db.activityLog.findMany({
      where: { entityType: "room", entityId: clone.id, action: "RoomCloned" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].data).toMatchObject({ fromSlug: ids.source, copiedEquipment: 2 });
  });

  it("omits gear when copyEquipment is false", async () => {
    const clone = await cloneRoom(
      actor,
      ids.source,
      cloneInput({ name: `${RUN} NoGear`, copyEquipment: false }),
    );
    createdRoomIds.push(clone.id);
    const gear = await db.equipment.findMany({ where: { roomId: clone.id } });
    expect(gear).toHaveLength(0);
  });
});
