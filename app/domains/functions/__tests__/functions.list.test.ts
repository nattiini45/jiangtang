import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { listNotWorking } from "../functions.queries.server";
import { transitionTicket } from "~/domains/tickets/tickets.mutations.server";

const roomIds: string[] = [];
let campusId: string;
let buildingId: string;
let functionId: string;
let faultId: string;

beforeAll(async () => {
  const campus = await db.campus.create({
    data: { name: "Synthetic fault campus", slug: "synthetic-fault-campus" },
  });
  campusId = campus.id;
  const building = await db.building.create({
    data: { name: "Synthetic fault building", campusId },
  });
  buildingId = building.id;
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  functionId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } })).id;
  for (let index = 0; index < 3; index++) {
    const room = await db.room.create({
      data: {
        name: `Synthetic fault room ${index}`,
        slug: `synthetic-fault-list-${index}`,
        campusId,
        buildingId,
      },
    });
    roomIds.push(room.id);
    await db.equipment.create({
      data: {
        roomId: room.id,
        kindId: kind.id,
        category: "PROJECTOR",
        status: index === 0 ? "FAULTY" : "OPERATIONAL",
        statusSince: null,
      },
    });
  }
  faultId = (
    await db.ticket.create({
      data: {
        title: "Synthetic old fault",
        type: "INCIDENT",
        roomId: roomIds[1],
        functionId,
        impact: "DOWN",
        occurredAt: new Date("2040-01-01T00:00:00Z"),
      },
    })
  ).id;
  await db.ticket.create({
    data: {
      title: "Synthetic newer fault",
      type: "INCIDENT",
      roomId: roomIds[2],
      functionId,
      impact: "LIMITED",
      occurredAt: new Date("2040-02-01T00:00:00Z"),
    },
  });
});

afterAll(async () => {
  await db.ticket.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.equipment.deleteMany({ where: { roomId: { in: roomIds } } });
  await db.room.deleteMany({ where: { id: { in: roomIds } } });
  await db.building.deleteMany({ where: { id: buildingId } });
  await db.campus.deleteMany({ where: { id: campusId } });
  await db.$disconnect();
});

it("uses the room's evidence, filters and sorts unknown starts before known dates", async () => {
  const rows = await listNotWorking({ campusId });
  expect(rows.map((row) => row.roomId)).toEqual(roomIds);
  expect(rows[0]).toMatchObject({ state: "DOWN", since: null, faults: [] });
  expect(rows[1].faults[0].id).toBe(faultId);
  expect(
    (await listNotWorking({ buildingId, functionKey: "picture", state: "LIMITED" })).map(
      (row) => row.roomId,
    ),
  ).toEqual([roomIds[2]]);
  expect(await listNotWorking({ campusId, functionId: "not-installed" })).toEqual([]);
  expect((await listNotWorking({ campusId, newestFirst: true })).map((row) => row.roomId)).toEqual(
    [...roomIds].reverse(),
  );
});

it("distinguishes assigned faults and removes a resolved fault without claiming works", async () => {
  const user = await db.user.findFirstOrThrow();
  await db.ticket.update({
    where: { id: faultId },
    data: { assignees: { connect: { id: user.id } } },
  });
  expect((await listNotWorking({ campusId, unassigned: true })).map((row) => row.roomId)).toEqual([
    roomIds[0],
    roomIds[2],
  ]);
  await transitionTicket({ name: "Synthetic list technician" }, faultId, {
    status: "RESOLVED",
    resolution: "Synthetic repair",
  });
  expect((await listNotWorking({ campusId })).map((row) => row.roomId)).toEqual([
    roomIds[0],
    roomIds[2],
  ]);
});
