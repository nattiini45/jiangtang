import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { createRoom, retireRoom, updateRoom } from "~/domains/rooms/rooms.mutations.server";
import type { RoomCreateInput } from "~/domains/rooms/rooms.schema";

/**
 * Room mutation guards: slug uniqueness (-2 on collision), retire-not-delete,
 * the DB renewal-order CHECK, and atomic room+audit writes. Cleanup deletes the
 * rooms + the campuses we auto-created by name; ActivityLog is append-only.
 */

const RUN = `room_${Date.now()}`;
const CAMPUS = `${RUN}-Campus`;
const actor = { id: null, name: "Room Tester", initials: "RT" };
const createdRoomIds: string[] = [];

afterAll(async () => {
  await db.room.deleteMany({ where: { id: { in: createdRoomIds } } });
  await db.building.deleteMany({ where: { campus: { name: CAMPUS } } });
  await db.campus.deleteMany({ where: { name: CAMPUS } });
  await db.$disconnect();
});

function input(over: Partial<RoomCreateInput> & { name: string }): RoomCreateInput {
  return {
    roomNumber: undefined,
    campusId: undefined,
    newCampusName: undefined,
    buildingId: undefined,
    newBuildingName: undefined,
    capacity: undefined,
    owner: undefined,
    status: "ALL_GOOD",
    hasProjector: false,
    hasMicrophony: false,
    hasBlackboard: false,
    hasWebConference: false,
    hasAutoRecording: false,
    mediaKeyRequired: false,
    videoInputs: [],
    audioOutputs: [],
    bookingUrl: undefined,
    manualUrl: undefined,
    virtualTourUrl: undefined,
    tipsNotes: undefined,
    renewalStatus: undefined,
    renewalFrom: undefined,
    renewalTo: undefined,
    ...over,
  };
}

describe("room mutations", () => {
  it("derives a unique slug (-2 on collision) and writes an audit row", async () => {
    const name = `${RUN} Saal`;
    const r1 = await createRoom(actor, input({ name, newCampusName: CAMPUS }));
    createdRoomIds.push(r1.id);
    const r2 = await createRoom(actor, input({ name, newCampusName: CAMPUS }));
    createdRoomIds.push(r2.id);

    expect(r2.slug).toBe(`${r1.slug}-2`);

    const logs = await db.activityLog.findMany({
      where: { entityType: "room", entityId: r1.id, action: "RoomCreated" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorSnapshot).toMatchObject({ initials: "RT" });
  });

  it("retires a room without deleting it", async () => {
    const r = await createRoom(actor, input({ name: `${RUN} Retire`, newCampusName: CAMPUS }));
    createdRoomIds.push(r.id);

    const retired = await retireRoom(actor, r.id);
    expect(retired.status).toBe("OUT_OF_SERVICE");

    const still = await db.room.findUnique({ where: { id: r.id } });
    expect(still).not.toBeNull();
  });

  it("rejects an inverted renewal window (DB CHECK rolls back)", async () => {
    await expect(
      createRoom(
        actor,
        input({
          name: `${RUN} Bad`,
          renewalFrom: new Date("2027-01-01T00:00:00Z"),
          renewalTo: new Date("2026-01-01T00:00:00Z"),
        }),
      ),
    ).rejects.toBeTruthy();

    const orphan = await db.room.findFirst({ where: { name: `${RUN} Bad` } });
    expect(orphan).toBeNull();
  });

  it("updates a room and audits it", async () => {
    const r = await createRoom(actor, input({ name: `${RUN} Upd`, newCampusName: CAMPUS }));
    createdRoomIds.push(r.id);

    const updated = await updateRoom(
      actor,
      r.id,
      input({ name: `${RUN} Upd`, newCampusName: CAMPUS, capacity: 120 }),
    );
    expect(updated.capacity).toBe(120);

    const logs = await db.activityLog.findMany({
      where: { entityType: "room", entityId: r.id, action: "RoomUpdated" },
    });
    expect(logs).toHaveLength(1);
  });

  // A caller-supplied campusId that conflicts with the building's actual
  // campus is a contradictory/stale form submission, not something to silently
  // override by trusting the building.
  it("rejects a room create whose campusId conflicts with the building's campus", async () => {
    const otherCampusName = `${RUN}-Other-Campus`;
    const otherCampus = await db.campus.create({
      data: { name: otherCampusName, slug: `${RUN}-other-campus` },
    });
    const building = await db.building.create({
      data: { campusId: otherCampus.id, name: `${RUN}-Building` },
    });

    const mainCampus = await db.campus.findFirst({ where: { name: CAMPUS } });
    // Ensure a "main" campus row exists distinct from otherCampus.
    const mainCampusId =
      mainCampus?.id ??
      (await db.campus.create({ data: { name: CAMPUS, slug: `${CAMPUS}-slug` } })).id;

    await expect(
      createRoom(
        actor,
        input({
          name: `${RUN} ConflictCampus`,
          campusId: mainCampusId,
          buildingId: building.id,
        }),
      ),
    ).rejects.toBeTruthy();

    const orphan = await db.room.findFirst({ where: { name: `${RUN} ConflictCampus` } });
    expect(orphan).toBeNull();

    // Cleanup this test's own extra rows (building + its campus).
    await db.building.deleteMany({ where: { id: building.id } });
    await db.campus.deleteMany({ where: { id: otherCampus.id } });
  });
});
