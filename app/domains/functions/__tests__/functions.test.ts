import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { txWithAudit } from "~/lib/audit.server";
import { deriveFunctionState } from "../functions.state";
import { reconcileFunctionsInTx } from "../functions.library.server";
import { getFunctionStates } from "../functions.queries.server";
import {
  createTicket,
  transitionTicket,
  updateTicket,
} from "~/domains/tickets/tickets.mutations.server";
import { ticketCreateSchema, ticketEditSchema } from "~/domains/tickets/tickets.schema";
import {
  createEquipment,
  updateEquipment,
  retireEquipment,
} from "~/domains/inventory/inventory.mutations.server";
import { equipmentCreateSchema } from "~/domains/inventory/inventory.schema";
import { deleteStructureEntry } from "~/lib/equipment-kinds/structure.server";
import { ValidationError } from "~/lib/errors.server";

const actor = { name: "Synthetic function technician" };
const older = new Date("2040-01-01T09:00:00Z");
const newer = new Date("2040-02-01T09:00:00Z");
const device = (id: string, faulty = false) => ({
  id,
  status: faulty ? ("FAULTY" as const) : ("OPERATIONAL" as const),
  statusSince: newer,
  role: "CARRIER" as const,
  substitutedBy: null,
});
const fault = {
  id: "fault",
  functionId: "function",
  equipmentId: null,
  impact: "DOWN" as const,
  occurredAt: older,
};

describe("derived function evidence", () => {
  it.each([
    ["no faults is neutral, not confirmed", [device("a"), device("b")], [], "NO_KNOWN_FAULT"],
    ["one of two carriers", [device("a", true), device("b")], [], "LIMITED"],
    ["all carriers", [device("a", true), device("b", true)], [], "DOWN"],
    [
      "a working substitute",
      [{ ...device("a", true), substitutedBy: { status: "OPERATIONAL" as const } }],
      [],
      "NO_KNOWN_FAULT",
    ],
    ["a path device", [{ ...device("a", true), role: "PATH" as const }], [], "LIMITED"],
    ["explicit fault beats working devices", [device("a")], [fault], "DOWN"],
    [
      "limited reports cannot hide all failed carriers",
      [device("a", true)],
      [{ ...fault, impact: "LIMITED" as const }],
      "DOWN",
    ],
    ["untriaged impact", [device("a")], [{ ...fault, impact: null }], "LIMITED"],
    [
      "device incident takes out the carrier",
      [device("a")],
      [{ ...fault, functionId: null, equipmentId: "a" }],
      "DOWN",
    ],
    [
      "a retired substitute cannot help",
      [{ ...device("a", true), substitutedBy: { status: "RETIRED" as const } }],
      [],
      "DOWN",
    ],
  ])("%s", (_label, devices, faults, expected) => {
    expect(deriveFunctionState(devices, faults).state).toBe(expected);
  });
  it("uses the oldest evidence at the current level, including an unknown start", () => {
    expect(deriveFunctionState([device("a", true)], [fault]).since).toEqual(older);
    expect(
      deriveFunctionState([{ ...device("a", true), statusSince: null }], [fault]).since,
    ).toBeNull();
    expect(
      deriveFunctionState(
        [{ ...device("path", true), role: "PATH", statusSince: older }, device("a", true)],
        [fault],
      ).since,
    ).toEqual(older);
  });
});

let roomId: string;
let equipmentId: string;
beforeAll(async () => {
  await txWithAudit(actor, reconcileFunctionsInTx);
  const room = await db.room.create({
    data: { name: "Synthetic function hall", slug: "synthetic-function-hall" },
  });
  roomId = room.id;
});
afterAll(async () => {
  if (!roomId) {
    await db.$disconnect();
    return;
  }
  await db.ticket.deleteMany({ where: { roomId } });
  await db.equipment.deleteMany({ where: { roomId } });
  await db.room.delete({ where: { id: roomId } });
  await db.$disconnect();
});

it("reconciles idempotently, preserves renames and only installs functions with a carrier kind", async () => {
  const initial = await db.roomFunction.findMany();
  expect(initial.map((row) => row.systemKey)).toEqual(
    expect.arrayContaining(["picture", "sound", "control", "lectern_connections"]),
  );
  const before = await db.activityLog.count({ where: { entityType: "roomFunction" } });
  await txWithAudit(actor, reconcileFunctionsInTx);
  expect(await db.activityLog.count({ where: { entityType: "roomFunction" } })).toBe(before);
  const carriers = await db.roomFunction.findMany({ include: { kinds: true } });
  expect(carriers.every((row) => row.kinds.some((link) => link.role === "CARRIER"))).toBe(true);
  const row = initial.find((row) => row.systemKey === "picture")!;
  await db.roomFunction.update({
    where: { id: row.id },
    data: { renamed: true, name: "Synthetic projection name" },
  });
  try {
    await txWithAudit(actor, reconcileFunctionsInTx);
    expect((await db.roomFunction.findUniqueOrThrow({ where: { id: row.id } })).name).toBe(
      "Synthetic projection name",
    );
  } finally {
    await db.roomFunction.update({
      where: { id: row.id },
      data: { renamed: row.renamed, name: row.name },
    });
  }
});

it("records status changes but leaves statusSince untouched for an ordinary edit", async () => {
  const input = equipmentCreateSchema.parse({
    name: "Synthetic projector",
    category: "PROJECTOR",
    roomId,
    mobility: "FIXED",
    status: "OPERATIONAL",
  });
  const equipment = await createEquipment(actor, input);
  equipmentId = equipment.id;
  expect(equipment.statusSince).toBeInstanceOf(Date);
  const unchanged = await updateEquipment(actor, equipment.id, {
    ...input,
    name: "Synthetic renamed projector",
  });
  expect(unchanged.statusSince).toEqual(equipment.statusSince);
  const faulty = await updateEquipment(actor, equipment.id, { ...input, status: "FAULTY" });
  expect(faulty.statusSince!.getTime()).toBeGreaterThanOrEqual(equipment.statusSince!.getTime());
  expect(
    (await getFunctionStates({ roomIds: [roomId] })).find((row) => row.systemKey === "picture")
      ?.state,
  ).toBe("DOWN");
  await updateEquipment(actor, equipment.id, input);
});

it("restricts deletion of a mapped kind and reports the reference before attempting deletion", async () => {
  const definition = await db.roomFunction.findFirstOrThrow();
  const group = await db.equipmentFunctionGroup.findFirstOrThrow();
  const kind = await db.equipmentKind.create({
    data: { name: "Synthetic mapped kind", groupId: group.id, position: 100, archivedAt: older },
  });
  try {
    await db.roomFunctionKind.create({
      data: { functionId: definition.id, kindId: kind.id, role: "PATH" },
    });
    await expect(db.equipmentKind.delete({ where: { id: kind.id } })).rejects.toThrow();
    await expect(deleteStructureEntry(actor, "kind", kind.id)).rejects.toBeInstanceOf(
      ValidationError,
    );
  } finally {
    await db.roomFunctionKind.deleteMany({ where: { kindId: kind.id } });
    await db.equipmentKind.delete({ where: { id: kind.id } });
  }
});

it("writes an audited phone fault, updates the hall and returns to neutral on resolution", async () => {
  const definition = await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } });
  const input = ticketCreateSchema.parse({
    title: "Synthetic projection fault",
    roomId,
    functionId: definition.id,
    impact: "DOWN",
    channel: "PHONE",
  });
  const ticket = await createTicket(actor, input);
  expect(
    await db.activityLog.count({ where: { entityId: ticket.id, action: "TicketCreated" } }),
  ).toBe(1);
  expect(
    (await getFunctionStates({ roomIds: [roomId] })).find((row) => row.functionId === definition.id)
      ?.state,
  ).toBe("DOWN");
  await transitionTicket(actor, ticket.id, {
    status: "RESOLVED",
    resolution: "Synthetic input replaced",
  });
  expect(
    (await getFunctionStates({ roomIds: [roomId] })).find((row) => row.functionId === definition.id)
      ?.state,
  ).toBe("NO_KNOWN_FAULT");
  await expect(createTicket(actor, { ...input, type: "REQUEST" })).rejects.toThrow();
  const control = await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "control" } });
  await expect(
    createTicket(actor, { ...input, functionId: control.id, equipmentId }),
  ).rejects.toThrow();
  expect((await createTicket(actor, { ...input, impact: undefined })).impact).toBe("LIMITED");
});

it("accepts the previous release's creates and retyping without altering the stored impact", async () => {
  const legacy = await db.ticket.create({
    data: { title: "Synthetic legacy incident", type: "INCIDENT", roomId },
  });
  expect(legacy.impact).toBeNull();
  await db.ticket.update({ where: { id: legacy.id }, data: { impact: "DOWN" } });
  const retyped = await db.ticket.update({ where: { id: legacy.id }, data: { type: "REQUEST" } });
  expect(retyped.impact).toBe("DOWN");
  expect(
    (
      await db.ticket.create({
        data: { title: "Synthetic legacy request", type: "REQUEST", roomId },
      })
    ).impact,
  ).toBeNull();
});

it("keeps an existing function fault editable after its last device is retired", async () => {
  const definition = await db.roomFunction.findUniqueOrThrow({ where: { systemKey: "picture" } });
  const ticket = await createTicket(
    actor,
    ticketCreateSchema.parse({
      title: "Synthetic historical fault",
      roomId,
      functionId: definition.id,
      impact: "DOWN",
    }),
  );
  await retireEquipment(actor, equipmentId);
  const edited = await updateTicket(
    actor,
    ticket.id,
    ticketEditSchema.parse({ title: "Synthetic edited historical fault", roomId }),
  );
  expect(edited.title).toBe("Synthetic edited historical fault");
  expect(edited.functionId).toBe(definition.id);
  expect(edited.impact).toBe("DOWN");
  await expect(
    updateTicket(
      actor,
      ticket.id,
      ticketEditSchema.parse({ title: edited.title, roomId, type: "REQUEST", impact: "DOWN" }),
    ),
  ).rejects.toThrow();
});
