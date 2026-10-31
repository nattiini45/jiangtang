import { afterAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { previewCsv } from "~/lib/csv/preview";
import { roomCsvRowSchema, type RoomCsvRow } from "~/domains/rooms/rooms.schema";
import { bulkCreateRooms } from "~/domains/rooms/rooms.mutations.server";

const RUN = `bulk_${Date.now()}`;
const CAMPUS = `${RUN}-Campus`;
const actor = { id: null, name: "Bulk Tester", initials: "BT" };

afterAll(async () => {
  await db.room.deleteMany({ where: { name: { startsWith: RUN } } });
  await db.building.deleteMany({ where: { campus: { name: CAMPUS } } });
  await db.campus.deleteMany({ where: { name: CAMPUS } });
  await db.$disconnect();
});

function makeRow(over: Partial<RoomCsvRow> & { name: string }): RoomCsvRow {
  return {
    roomNumber: undefined,
    campusName: undefined,
    buildingName: undefined,
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
    ...over,
  };
}

describe("bulk room import", () => {
  it("previewCsv splits valid and invalid rows", () => {
    const csv = `name,campus,projektor\n${RUN} A,${CAMPUS},ja\n,${CAMPUS},nein`;
    const pv = previewCsv(csv, roomCsvRowSchema);
    expect(pv.valid).toHaveLength(1);
    expect(pv.invalid).toHaveLength(1);
    expect(pv.valid[0].data.campusName).toBe(CAMPUS);
    expect(pv.valid[0].data.hasProjector).toBe(true);
    expect(pv.invalid[0].line).toBe(3);
  });

  it("commits the batch and upserts the shared campus once", async () => {
    const rows = [
      makeRow({ name: `${RUN} R1`, campusName: CAMPUS }),
      makeRow({ name: `${RUN} R2`, campusName: CAMPUS }),
    ];
    const { created } = await bulkCreateRooms(actor, rows);
    expect(created).toBe(2);

    const campuses = await db.campus.findMany({ where: { name: CAMPUS } });
    expect(campuses).toHaveLength(1);
    const rooms = await db.room.findMany({ where: { name: { startsWith: `${RUN} R` } } });
    expect(rooms).toHaveLength(2);
  });

  it("is atomic — a bad row rolls the whole batch back", async () => {
    const good = makeRow({ name: `${RUN} Atomic1`, campusName: CAMPUS });
    // Invalid enum reaches the DB and is rejected (bypassing the row schema).
    const bad = makeRow({
      name: `${RUN} Atomic2`,
      status: "BOGUS" as unknown as RoomCsvRow["status"],
    });

    await expect(bulkCreateRooms(actor, [good, bad])).rejects.toBeTruthy();

    const leaked = await db.room.findFirst({ where: { name: `${RUN} Atomic1` } });
    expect(leaked).toBeNull();
  });
});
