import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { deriveFunctionState } from "../functions.state";
import { getFunctionStates, listNotWorking } from "../functions.queries.server";
import {
  startRound,
  recordCheck,
  setFunctionState,
  clearFunctionState,
} from "../rounds.mutations.server";
import { getRound } from "../rounds.queries.server";
import { ValidationError } from "~/lib/errors.server";

const actor = { name: "Synthetic round technician", role: "ADMIN" };
const at = new Date("2040-03-01T12:00:00Z");
const before = new Date("2040-02-01T12:00:00Z");
const after = new Date("2040-04-01T12:00:00Z");
const device = {
  id: "device",
  role: "CARRIER" as const,
  status: "OPERATIONAL" as const,
  statusSince: before,
  substitutedBy: null,
};

describe("confirmation and the newest human statement", () => {
  const confirmation = {
    now: at,
    days: 200,
    evidenceAt: before,
    check: { result: "WORKS" as const, checkedAt: before },
  };
  it("is green only while the check is current, recent and not contradicted", () => {
    expect(deriveFunctionState([device], [], confirmation).state).toBe("WORKS");
    expect(deriveFunctionState([device], [], { ...confirmation, evidenceAt: after }).state).toBe(
      "NO_KNOWN_FAULT",
    );
    expect(
      deriveFunctionState([device], [], {
        ...confirmation,
        now: new Date(before.getTime() + 200 * 86_400_000),
      }).state,
    ).toBe("NO_KNOWN_FAULT");
    expect(
      deriveFunctionState([device], [], {
        ...confirmation,
        check: { result: "NOT_CHECKED", checkedAt: at },
      }).state,
    ).toBe("NO_KNOWN_FAULT");
    expect(
      deriveFunctionState([device], [], {
        ...confirmation,
        check: { result: "WORKS", checkedAt: after },
      }).state,
    ).toBe("NO_KNOWN_FAULT");
    expect(deriveFunctionState([{ ...device, status: "FAULTY" }], [], confirmation).state).toBe(
      "DOWN",
    );
  });
  it("ends a state set by hand at its end, new evidence or a new check", () => {
    const override = {
      state: "DOWN" as const,
      setAt: at,
      until: after,
      reason: "Synthetic reason",
    };
    const input = { ...confirmation, override };
    expect(deriveFunctionState([device], [], input)).toMatchObject({
      state: "DOWN",
      manualReason: override.reason,
    });
    expect(deriveFunctionState([device], [], { ...input, now: after }).state).toBe("WORKS");
    expect(deriveFunctionState([device], [], { ...input, evidenceAt: after }).state).toBe(
      "NO_KNOWN_FAULT",
    );
    expect(
      deriveFunctionState([device], [], {
        ...input,
        check: { result: "WORKS", checkedAt: after },
        now: after,
      }).state,
    ).toBe("WORKS");
  });
});

let roomId: string;
let functionId: string;
let deviceId: string;
const rounds: string[] = [];
beforeEach(async () => {
  const room = await db.room.create({
    data: { name: "Synthetic round hall", slug: `round-${crypto.randomUUID()}` },
  });
  roomId = room.id;
  const kind = await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } });
  functionId = (await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } })).id;
  deviceId = (
    await db.equipment.create({
      data: {
        roomId,
        kindId: kind.id,
        category: "PROJECTOR",
        statusSince: new Date("2020-01-01T00:00:00Z"),
      },
    })
  ).id;
});
afterEach(async () => {
  await db.roomCheck.deleteMany({ where: { roomId } });
  await db.functionOverride.deleteMany({ where: { roomId } });
  await db.round.deleteMany({ where: { id: { in: rounds.splice(0) } } });
  await db.ticket.deleteMany({ where: { roomId } });
  await db.equipment.deleteMany({ where: { roomId } });
  await db.room.delete({ where: { id: roomId } });
});
afterAll(() => db.$disconnect());
async function round() {
  const row = await startRound(actor, { name: "Synthetic semester round", roomIds: [roomId] });
  rounds.push(row.id);
  return row;
}
async function state() {
  return (await getFunctionStates({ roomIds: [roomId] })).find(
    (row) => row.functionId === functionId,
  )!;
}

it("records a passing room, closes its round and audits completion atomically", async () => {
  const row = await round();
  expect((await getRound(row.id))?.done).toBe(0);
  const check = await recordCheck(actor, { roomId, functionId, roundId: row.id, result: "WORKS" });
  expect(await state()).toMatchObject({ state: "WORKS", lastCheckedAt: check.checkedAt });
  expect(await getRound(row.id)).toMatchObject({ done: 1, faults: [], closedAt: expect.any(Date) });
  expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).lastCheckedAt).toEqual(
    check.checkedAt,
  );
  expect(await db.activityLog.count({ where: { entityId: roomId, action: "RoomChecked" } })).toBe(
    1,
  );
  expect((await listNotWorking()).some((entry) => entry.roomId === roomId)).toBe(false);
});

it("serializes double taps and retries into exactly one failed check and fault", async () => {
  const row = await round();
  const input = {
    roomId,
    functionId,
    roundId: row.id,
    result: "DOWN" as const,
    note: "Synthetic dark picture",
  };
  const [a, b] = await Promise.all([recordCheck(actor, input), recordCheck(actor, input)]);
  expect(a.id).toBe(b.id);
  expect(a.ticketId).toBe(b.ticketId);
  expect(await db.ticket.count({ where: { roomId } })).toBe(1);
  expect(await db.roomCheck.count({ where: { roomId } })).toBe(1);
  expect(await state()).toMatchObject({ state: "DOWN" });
  expect((await getRound(row.id))?.faults).toHaveLength(1);
});

it("leaves skipped rooms open and lets them be checked later", async () => {
  const row = await round();
  await recordCheck(actor, { roomId, functionId, roundId: row.id, result: "NOT_CHECKED" });
  expect((await getRound(row.id))?.done).toBe(0);
  await recordCheck(actor, { roomId, functionId, roundId: row.id, result: "WORKS" });
  expect((await getRound(row.id))?.done).toBe(1);
});

it("adds repeated failures to the open fault across rounds without lowering its impact", async () => {
  const first = await recordCheck(actor, {
    roomId,
    functionId,
    result: "LIMITED",
    note: "Synthetic first observation",
  });
  for (const result of ["DOWN", "LIMITED"] as const) {
    const row = await round();
    const check = await recordCheck(actor, {
      roomId,
      functionId,
      roundId: row.id,
      result,
      note: "Synthetic later observation",
    });
    expect(check.ticketId).toBe(first.ticketId);
    expect((await getRound(row.id))?.faults).toHaveLength(1);
  }
  expect(await db.ticket.count({ where: { roomId } })).toBe(1);
  const fault = await db.ticket.findUniqueOrThrow({ where: { id: first.ticketId! } });
  expect(fault.impact).toBe("DOWN");
  expect(fault.description).toContain("Synthetic first observation\n\nSynthetic later observation");
});

it("skipping preserves the previous confirmation and admin statement, while an observed check audits its end", async () => {
  await recordCheck(actor, { roomId, functionId, result: "WORKS" });
  await recordCheck(actor, { roomId, functionId, result: "NOT_CHECKED" });
  expect((await state()).state).toBe("WORKS");
  const override = await setFunctionState(actor, {
    roomId,
    functionId,
    state: "DOWN",
    reason: "Synthetic ongoing restriction",
  });
  await recordCheck(actor, { roomId, functionId, result: "NOT_CHECKED" });
  expect(await state()).toMatchObject({
    state: "DOWN",
    manualReason: "Synthetic ongoing restriction",
  });
  expect(
    (await db.functionOverride.findUniqueOrThrow({ where: { id: override.id } })).endedAt,
  ).toBeNull();
  await recordCheck(actor, { roomId, functionId, result: "WORKS" });
  expect((await state()).state).toBe("WORKS");
  expect(
    await db.activityLog.count({
      where: {
        entityId: roomId,
        action: "FunctionStateCleared",
        data: { path: ["overrideId"], equals: override.id },
      },
    }),
  ).toBe(1);
});

it("doesn't silently close faults or restore devices when a passing check contradicts them", async () => {
  const fault = await db.ticket.create({
    data: { roomId, functionId, title: "Synthetic fault", type: "INCIDENT", impact: "DOWN" },
  });
  await db.equipment.update({
    where: { id: deviceId },
    data: { status: "FAULTY", statusSince: new Date() },
  });
  await recordCheck(actor, { roomId, functionId, result: "WORKS" });
  expect((await state()).state).toBe("DOWN");
  await expect(
    recordCheck(actor, { roomId, functionId, result: "WORKS", resolveFaults: [fault.id] }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    recordCheck(actor, {
      roomId,
      functionId,
      result: "WORKS",
      resolveFaults: [fault.id],
      resolution: "Synthetic repair",
      restoreDevices: ["not-this-device"],
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect((await db.ticket.findUniqueOrThrow({ where: { id: fault.id } })).status).toBe("OPEN");
  await recordCheck(actor, {
    roomId,
    functionId,
    result: "WORKS",
    resolveFaults: [fault.id],
    resolution: "Synthetic repair",
    restoreDevices: [deviceId],
  });
  expect((await state()).state).toBe("WORKS");
  expect((await state()).knownFixes).toHaveLength(1);
  expect((await db.equipment.findUniqueOrThrow({ where: { id: deviceId } })).status).toBe(
    "OPERATIONAL",
  );
});

it("requires admin, a reason and a future end, replaces an override and audits its clear", async () => {
  await expect(
    setFunctionState(
      { ...actor, role: "MEMBER" },
      { roomId, functionId, state: "DOWN", reason: "Synthetic reason" },
    ),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    setFunctionState(actor, { roomId, functionId, state: "DOWN", reason: " " }),
  ).rejects.toThrow();
  await expect(
    setFunctionState(actor, {
      roomId,
      functionId,
      state: "DOWN",
      reason: "Synthetic reason",
      until: new Date("2020-01-01T00:00:00Z"),
    }),
  ).rejects.toBeInstanceOf(ValidationError);
  await setFunctionState(actor, { roomId, functionId, state: "DOWN", reason: "Synthetic reason" });
  expect((await state()).state).toBe("DOWN");
  await setFunctionState(actor, {
    roomId,
    functionId,
    state: "LIMITED",
    reason: "Synthetic revised reason",
  });
  expect(await db.functionOverride.count({ where: { roomId, endedAt: null } })).toBe(1);
  expect((await state()).state).toBe("LIMITED");
  await clearFunctionState(actor, roomId, functionId);
  expect((await state()).state).toBe("NO_KNOWN_FAULT");
  expect(
    await db.activityLog.count({ where: { entityId: roomId, action: "FunctionStateCleared" } }),
  ).toBe(1);
});

it("enforces one open override in the database, including expired overrides", async () => {
  const input = { roomId, functionId, state: "DOWN" as const, reason: "Synthetic reason" };
  await db.functionOverride.create({ data: { ...input, until: new Date("2020-01-01T00:00:00Z") } });
  await expect(db.functionOverride.create({ data: input })).rejects.toMatchObject({
    code: "P2002",
  });
  expect((await state()).state).toBe("NO_KNOWN_FAULT");
  await setFunctionState(actor, input);
  expect((await state()).state).toBe("DOWN");
});

it("rejects rooms outside the selected round and unknown functions without creating faults", async () => {
  await expect(
    recordCheck(actor, { roomId, functionId, roundId: "not-a-round", result: "DOWN" }),
  ).rejects.toBeInstanceOf(ValidationError);
  await expect(
    recordCheck(actor, { roomId, functionId: "not-a-function", result: "LIMITED" }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect(await db.ticket.count({ where: { roomId } })).toBe(0);
  expect(await db.roomCheck.count({ where: { roomId } })).toBe(0);
});
