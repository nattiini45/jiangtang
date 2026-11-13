import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import library from "~/lib/equipment-kinds/library.json" with { type: "json" };
import { expectedFunctionIds } from "~/domains/functions/functions.expectations";
import { getFunctionStates, listNotWorking } from "~/domains/functions/functions.queries.server";
import {
  startRound,
  recordCheck,
  finishEmptyRoundRoom,
} from "~/domains/functions/rounds.mutations.server";
import { roundTargets, getRound } from "~/domains/functions/rounds.queries.server";
import { reconcileRoomTypesInTx } from "../room-types.library.server";
import { listRoomTypes } from "../room-types.queries.server";
import { setRoomType, setFunctionExpected } from "../room-types.mutations.server";
import { createRoom, updateRoom, cloneRoom, bulkCreateRooms } from "../rooms.mutations.server";
import { roomCreateSchema, roomCloneSchema, roomCsvRowSchema } from "../rooms.schema";
import { createTicket } from "~/domains/tickets/tickets.mutations.server";
import { ticketCreateSchema } from "~/domains/tickets/tickets.schema";

const actor = { name: "Synthetic room technician" };
const marker = "room-function-expectations";
const rooms: string[] = [];
const rounds: string[] = [];
let oldFunctions: string[];
let oldTypes: string[];
let roomId: string;
let pictureId: string;
let typeId: string;
let originalMarker: Awaited<ReturnType<typeof db.libraryState.findUnique>>;

beforeAll(async () => {
  oldFunctions = (await db.roomFunction.findMany()).map((row) => row.id);
  oldTypes = (await db.roomType.findMany()).map((row) => row.id);
  originalMarker = await db.libraryState.findUnique({ where: { key: marker } });
  await db.libraryState.deleteMany({ where: { key: marker } });
  const room = await db.room.create({
    data: {
      name: "Synthetic legacy hall",
      slug: `types-${crypto.randomUUID()}`,
      hasProjector: true,
      hasMicrophony: true,
      hasAutoRecording: true,
      hasWebConference: true,
    },
  });
  roomId = room.id;
  rooms.push(roomId);
  await expect(
    txWithAudit(actor, (tx, audit) =>
      reconcileRoomTypesInTx(tx, async (entry) => {
        await audit(entry);
        if (entry.action === "RoomExpectationsCopied")
          throw new Error("Synthetic interrupted copy");
      }),
    ),
  ).rejects.toThrow("Synthetic interrupted copy");
  expect(await db.libraryState.findUnique({ where: { key: marker } })).toBeNull();
  expect(await db.roomFunctionExpectation.count({ where: { roomId } })).toBe(0);
  await txWithAudit(actor, reconcileRoomTypesInTx);
  pictureId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } })).id;
  typeId = (await db.roomType.findUniqueOrThrow({ where: { systemKey: "lecture_hall" } })).id;
});

afterAll(async () => {
  await db.round.deleteMany({ where: { id: { in: rounds } } });
  await db.roomCheck.deleteMany({ where: { roomId: { in: rooms } } });
  await db.functionOverride.deleteMany({ where: { roomId: { in: rooms } } });
  await db.ticket.deleteMany({ where: { roomId: { in: rooms } } });
  await db.equipment.deleteMany({ where: { roomId: { in: rooms } } });
  await db.room.deleteMany({ where: { id: { in: rooms } } });
  await db.roomType.deleteMany({ where: { id: { notIn: oldTypes } } });
  await db.roomFunctionExpectation.deleteMany({ where: { functionId: { notIn: oldFunctions } } });
  await db.roomFunction.deleteMany({ where: { id: { notIn: oldFunctions } } });
  await db.libraryState.deleteMany({ where: { key: marker } });
  if (originalMarker) await db.libraryState.create({ data: originalMarker });
  await db.$disconnect();
});

it("ships all researched types with complete carrier-derived content, including non-academic rooms", async () => {
  expect(library.roomTypes).toHaveLength(15);
  expect(library.roomTypes.map((type) => type.key)).toEqual(
    expect.arrayContaining([
      "lecture_hall",
      "event_hall",
      "council_chamber",
      "conference_room",
      "exhibition_hall",
      "open_air",
    ]),
  );
  const types = await listRoomTypes();
  for (const definition of library.roomTypes) {
    const row = types.find((type) => type.systemKey === definition.key)!;
    expect(row.functions.map((link) => link.functionId).sort()).toEqual(
      (await db.roomFunction.findMany({ where: { systemKey: { in: definition.functions } } }))
        .map((fn) => fn.id)
        .sort(),
    );
  }
  expect(library.roomTypes.find((type) => type.key === "lecture_hall")?.functions).toContain(
    "recording",
  );
});

it("copies the four true flags once, rolls back interrupted copies and preserves adjustments and type renames", async () => {
  expect(await db.roomFunctionExpectation.count({ where: { roomId, expected: true } })).toBe(4);
  await setFunctionExpected(actor, roomId, {
    functionId: pictureId,
    expected: false,
    note: "Synthetic intentional omission",
  });
  const before = await db.activityLog.count({
    where: { action: { in: ["RoomExpectationsCopied", "RoomTypeReconciled"] } },
  });
  await db.roomType.update({
    where: { id: typeId },
    data: { name: "Synthetic own room type", renamed: true },
  });
  await txWithAudit(actor, reconcileRoomTypesInTx);
  expect(
    await db.activityLog.count({
      where: { action: { in: ["RoomExpectationsCopied", "RoomTypeReconciled"] } },
    }),
  ).toBe(before);
  expect((await listRoomTypes()).find((type) => type.id === typeId)?.name).toBe(
    "Synthetic own room type",
  );
  expect(
    await db.roomFunctionExpectation.findUnique({
      where: { roomId_functionId: { roomId, functionId: pictureId } },
    }),
  ).toMatchObject({ expected: false });
  await db.roomType.update({ where: { id: typeId }, data: { name: "Hörsaal", renamed: false } });
});

it("resolves type union additions minus removals, with device fallback only for untyped rooms", () => {
  const room = {
    roomTypeId: "type",
    roomType: { functions: [{ functionId: "a" }, { functionId: "b" }] },
    functionExpectations: [
      { functionId: "a", expected: false },
      { functionId: "c", expected: true },
    ],
  };
  expect([...expectedFunctionIds(room, ["d"])]).toEqual(["b", "c"]);
  expect([...expectedFunctionIds({ ...room, roomTypeId: null }, ["a", "d"])]).toEqual(["d", "c"]);
});

async function syntheticRoom() {
  const room = await db.room.create({
    data: { name: "Synthetic typed hall", slug: `typed-${crypto.randomUUID()}` },
  });
  rooms.push(room.id);
  return room;
}

it("shows gaps, never faults, without a carrier and preserves explicit faults after retirement", async () => {
  const room = await syntheticRoom();
  await setRoomType(actor, { roomIds: [room.id], roomTypeId: typeId });
  let states = await getFunctionStates({ roomIds: [room.id] });
  expect(states.length).toBeGreaterThan(4);
  expect(states.every((row) => row.expected && row.state === "MISSING")).toBe(true);
  expect((await listNotWorking()).filter((row) => row.roomId === room.id)).toEqual([]);
  const kind = await db.equipmentKind.findUniqueOrThrow({
    where: { systemKey: "presentation_switcher" },
  });
  await db.equipment.create({
    data: { roomId: room.id, kindId: kind.id, category: "SWITCHER", status: "FAULTY" },
  });
  states = await getFunctionStates({ roomIds: [room.id] });
  expect(states.find((row) => row.functionId === pictureId)).toMatchObject({
    state: "MISSING",
    hasCarrier: false,
  });
  const projector = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  const device = await db.equipment.create({
    data: { roomId: room.id, kindId: projector.id, category: "PROJECTOR" },
  });
  const fault = await db.ticket.create({
    data: {
      roomId: room.id,
      functionId: pictureId,
      type: "INCIDENT",
      title: "Synthetic projection failure",
      status: "OPEN",
      impact: "DOWN",
    },
  });
  await db.equipment.update({ where: { id: device.id }, data: { status: "RETIRED" } });
  const state = (await getFunctionStates({ roomIds: [room.id] })).find(
    (row) => row.functionId === pictureId,
  )!;
  expect(state).toMatchObject({ expected: true, state: "DOWN", hasCarrier: false });
  expect(state.faults.map((row) => row.id)).toContain(fault.id);
  await db.ticket.update({ where: { id: fault.id }, data: { status: "RESOLVED" } });
  expect(
    (await getFunctionStates({ roomIds: [room.id] })).find((row) => row.functionId === pictureId)
      ?.state,
  ).toBe("MISSING");
});

it("dual-writes old flags for form, bulk type assignment, adjustments, CSV and cloning", async () => {
  const created = await createRoom(
    actor,
    roomCreateSchema.parse({
      name: "Synthetic expected room",
      roomTypeId: typeId,
      expectations: [],
    }),
  );
  rooms.push(created.id);
  expect(created).toMatchObject({
    hasProjector: true,
    hasAutoRecording: true,
    hasWebConference: false,
  });
  const updated = await updateRoom(
    actor,
    created.id,
    roomCreateSchema.parse({
      name: created.name,
      roomTypeId: typeId,
      expectations: [{ functionId: pictureId, expected: false, note: "Synthetic omission" }],
    }),
  );
  expect(updated.hasProjector).toBe(false);
  await setFunctionExpected(actor, created.id, { functionId: pictureId, expected: null });
  expect((await db.room.findUniqueOrThrow({ where: { id: created.id } })).hasProjector).toBe(true);
  const cloned = await cloneRoom(
    actor,
    created.slug,
    roomCloneSchema.parse({ name: "Synthetic cloned type", copyFeatures: true }),
  );
  rooms.push(cloned.id);
  expect(cloned.roomTypeId).toBe(typeId);
  const csv = await bulkCreateRooms(actor, [
    roomCsvRowSchema.parse({ name: "Synthetic CSV expectations", projektor: "ja" }),
  ]);
  rooms.push(...csv.items.map((room) => room.id));
  expect(
    await db.roomFunctionExpectation.findUnique({
      where: { roomId_functionId: { roomId: csv.items[0].id, functionId: pictureId } },
    }),
  ).toMatchObject({ expected: true });
  const legacy = await createRoom(
    actor,
    roomCreateSchema.parse({ name: "Synthetic legacy writer", hasProjector: true }),
  );
  rooms.push(legacy.id);
  expect(
    (await getFunctionStates({ roomIds: [legacy.id] })).find((row) => row.functionId === pictureId)
      ?.state,
  ).toBe("MISSING");
  await expect(
    setRoomType(actor, { roomIds: [created.id, "not-a-room"], roomTypeId: null }),
  ).rejects.toThrow();
  expect((await db.room.findUniqueOrThrow({ where: { id: created.id } })).roomTypeId).toBe(typeId);
});

it("keeps gaps visible without requiring or recording a result and safely finishes after retirement", async () => {
  const room = await syntheticRoom();
  const type = await db.roomType.create({
    data: {
      name: "Synthetic projection space",
      position: 100,
      functions: { create: { functionId: pictureId } },
    },
  });
  await setRoomType(actor, { roomIds: [room.id], roomTypeId: type.id });
  expect((await roundTargets()).some((row) => row.id === room.id)).toBe(true);
  const round = await startRound(actor, { name: "Synthetic expected round", roomIds: [room.id] });
  rounds.push(round.id);
  for (const result of ["WORKS", "LIMITED", "DOWN", "NOT_CHECKED"] as const) {
    await expect(
      recordCheck(actor, { roundId: round.id, roomId: room.id, functionId: pictureId, result }),
    ).rejects.toThrow();
  }
  expect(await db.ticket.count({ where: { roomId: room.id } })).toBe(0);
  expect(await db.roomCheck.count({ where: { roomId: room.id } })).toBe(0);
  await finishEmptyRoundRoom(actor, round.id, room.id);
  expect((await getRound(round.id))?.closedAt).toBeInstanceOf(Date);
  expect((await getFunctionStates({ roomIds: [room.id] }))[0].state).toBe("MISSING");
  const untyped = await syntheticRoom();
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  const device = await db.equipment.create({
    data: { roomId: untyped.id, kindId: kind.id, category: "PROJECTOR" },
  });
  const empty = await startRound(actor, {
    name: "Synthetic changed inventory",
    roomIds: [untyped.id],
  });
  rounds.push(empty.id);
  await expect(finishEmptyRoundRoom(actor, empty.id, untyped.id)).rejects.toThrow();
  await db.equipment.update({ where: { id: device.id }, data: { status: "RETIRED" } });
  await finishEmptyRoundRoom(actor, empty.id, untyped.id);
  expect((await getRound(empty.id))?.done).toBe(1);
  expect((await getRound(empty.id))?.closedAt).toBeInstanceOf(Date);
});

it("checks installed functions outside the type while leaving expected gaps as planning facts", async () => {
  const room = await syntheticRoom();
  const type = await db.roomType.create({
    data: {
      name: "Synthetic picture-only room",
      position: 101,
      functions: { create: { functionId: pictureId } },
    },
  });
  await setRoomType(actor, { roomIds: [room.id], roomTypeId: type.id });
  const recorder = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "recorder" } });
  await db.equipment.create({
    data: { roomId: room.id, kindId: recorder.id, category: "RECORDER" },
  });
  const recording = await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "recording" } });
  expect(
    (await getFunctionStates({ roomIds: [room.id] })).find((fn) => fn.functionId === recording.id),
  ).toMatchObject({ expected: false, hasCarrier: true });
  const round = await startRound(actor, {
    name: "Synthetic extra installed function",
    roomIds: [room.id],
  });
  rounds.push(round.id);
  await recordCheck(actor, {
    roomId: room.id,
    roundId: round.id,
    functionId: recording.id,
    result: "WORKS",
  });
  expect((await getRound(round.id))?.done).toBe(1);
  await expect(
    recordCheck(actor, { roomId: room.id, functionId: recording.id, result: "WORKS" }),
  ).resolves.toMatchObject({ result: "WORKS" });
  expect(
    (await getFunctionStates({ roomIds: [room.id] })).find((fn) => fn.functionId === pictureId)
      ?.state,
  ).toBe("MISSING");
});

it("does not infer expectations or old flags from path devices, or accept a gap as a new fault", async () => {
  const room = await syntheticRoom();
  const kind = await db.equipmentKind.findUniqueOrThrow({
    where: { systemKey: "presentation_switcher" },
  });
  const device = await db.equipment.create({
    data: { roomId: room.id, kindId: kind.id, category: "SWITCHER" },
  });
  await setRoomType(actor, { roomIds: [room.id], roomTypeId: null });
  expect(await db.room.findUnique({ where: { id: room.id } })).toMatchObject({
    hasProjector: false,
    hasMicrophony: false,
  });
  expect(
    (await getFunctionStates({ roomIds: [room.id] })).some((fn) => fn.functionId === pictureId),
  ).toBe(false);
  await setFunctionExpected(actor, room.id, { functionId: pictureId, expected: true });
  expect(
    (await getFunctionStates({ roomIds: [room.id] })).find((fn) => fn.functionId === pictureId)
      ?.state,
  ).toBe("MISSING");
  await expect(
    createTicket(
      actor,
      ticketCreateSchema.parse({
        roomId: room.id,
        equipmentId: device.id,
        functionId: pictureId,
        type: "INCIDENT",
        title: "Synthetic gap is not a fault",
      }),
    ),
  ).rejects.toThrow();
  expect(await db.ticket.count({ where: { roomId: room.id } })).toBe(0);
});
