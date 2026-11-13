import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import {
  createTicket,
  transitionTicket,
  updateTicket,
} from "~/domains/tickets/tickets.mutations.server";
import { ticketCreateSchema, ticketEditSchema } from "~/domains/tickets/tickets.schema";
import { editKnownFix } from "~/domains/tickets/tickets.known-fixes.server";
import { moveKnownIssues } from "~/domains/rooms/rooms.known-fixes.server";
import { getFunctionStates } from "../functions.queries.server";
import { ValidationError } from "~/lib/errors.server";

const actor = { name: "Synthetic fix technician" };
let roomId: string;
let functionId: string;
let deviceId: string;
const note = "Synthetic earlier note:\nswitch the input twice.";
beforeAll(async () => {
  const room = await db.room.create({
    data: { name: "Synthetic fixes hall", slug: `fixes-${crypto.randomUUID()}`, knownIssues: note },
  });
  roomId = room.id;
  const definition = await db.roomFunction.findUniqueOrThrow({
    where: { systemKey: "picture" },
    include: { kinds: true },
  });
  functionId = definition.id;
  deviceId = (
    await db.equipment.create({
      data: {
        roomId,
        kindId: definition.kinds.find((kind) => kind.role === "CARRIER")!.kindId,
        category: "PROJECTOR",
        name: "Synthetic projector",
      },
    })
  ).id;
});
afterAll(async () => {
  await db.ticket.deleteMany({ where: { roomId } });
  await db.equipment.deleteMany({ where: { roomId } });
  await db.room.delete({ where: { id: roomId } });
  await db.$disconnect();
});
const states = async () =>
  (await getFunctionStates({ roomIds: [roomId] })).find((row) => row.functionId === functionId)!;
const create = (title: string) =>
  createTicket(actor, ticketCreateSchema.parse({ title, roomId, functionId }));

it("requires what helped, keeps only explicitly retained resolutions, and clears retention on reopen", async () => {
  const ticket = await create("Synthetic missing picture");
  await expect(
    transitionTicket(actor, ticket.id, { status: "RESOLVED", keepAsFix: true, resolution: " " }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect((await states()).knownFixes).toHaveLength(0);
  await transitionTicket(actor, ticket.id, {
    status: "RESOLVED",
    resolution: "Changed input",
    keepAsFix: true,
  });
  expect((await states()).knownFixes.map((fix) => fix.id)).toEqual([ticket.id]);
  await transitionTicket(actor, ticket.id, { status: "OPEN" });
  expect((await states()).knownFixes).toHaveLength(0);
  await transitionTicket(actor, ticket.id, {
    status: "RESOLVED",
    resolution: "Not retained",
    keepAsFix: false,
  });
  expect((await states()).knownFixes).toHaveLength(0);
});

it("moves the note exactly once under concurrent submissions and audits both changes", async () => {
  const [first, second] = await Promise.all([
    moveKnownIssues(actor, roomId, { functionId, note: note.replace(/\n/g, "\r\n") }),
    moveKnownIssues(actor, roomId, { functionId, note }),
  ]);
  const ticket = first ?? second;
  expect([first, second].filter(Boolean)).toHaveLength(1);
  expect(ticket).toMatchObject({
    type: "REPAIR",
    status: "RESOLVED",
    resolution: note,
    keepAsFix: true,
  });
  expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).knownIssues).toBeNull();
  expect(
    await db.activityLog.findMany({
      where: { entityType: "room", entityId: roomId, action: "RoomUpdated" },
    }),
  ).toEqual([
    expect.objectContaining({
      data: { knownIssuesMovedToTicketId: ticket!.id, clearedFields: ["knownIssues"] },
    }),
  ]);
  expect(
    await db.activityLog.count({ where: { entityId: ticket!.id, action: "TicketResolved" } }),
  ).toBe(1);
});

it("rejects stale notes and invalid functions without clearing or creating anything", async () => {
  await db.room.update({ where: { id: roomId }, data: { knownIssues: "New synthetic note" } });
  const before = await db.ticket.count({ where: { roomId } });
  await expect(moveKnownIssues(actor, roomId, { functionId, note })).rejects.toBeInstanceOf(
    ValidationError,
  );
  await expect(
    moveKnownIssues(actor, roomId, { functionId: "missing", note: "New synthetic note" }),
  ).rejects.toBeInstanceOf(ValidationError);
  expect((await db.room.findUniqueOrThrow({ where: { id: roomId } })).knownIssues).toBe(
    "New synthetic note",
  );
  expect(await db.ticket.count({ where: { roomId } })).toBe(before);
});

it("orders fixes newest first, retains them without devices, and audits edits and drops", async () => {
  const older = await createTicket(
    actor,
    ticketCreateSchema.parse({
      title: "Older fault",
      roomId,
      functionId,
      type: "REPAIR",
      status: "RESOLVED",
      resolution: "Old help",
      keepAsFix: true,
      resolvedAt: "2040-01-01",
    }),
  );
  const newer = await createTicket(
    actor,
    ticketCreateSchema.parse({
      title: "Newer fault",
      roomId,
      functionId,
      type: "REPAIR",
      status: "RESOLVED",
      resolution: "New help",
      keepAsFix: true,
      resolvedAt: "2041-01-01",
    }),
  );
  expect((await states()).knownFixes.slice(0, 2).map((fix) => fix.id)).toEqual([
    newer.id,
    older.id,
  ]);
  await editKnownFix(actor, roomId, {
    intent: "edit",
    id: newer.id,
    title: "Corrected fault",
    resolution: "Corrected help",
  });
  expect((await states()).knownFixes[0]).toMatchObject({
    title: "Corrected fault",
    resolution: "Corrected help",
  });
  await expect(
    editKnownFix(actor, "other-room", { intent: "drop", id: newer.id }),
  ).rejects.toBeDefined();
  await updateTicket(
    actor,
    newer.id,
    ticketEditSchema.parse({ type: "REPAIR", title: "Corrected fault", roomId, keepAsFix: false }),
  );
  expect((await states()).knownFixes.some((fix) => fix.id === newer.id)).toBe(false);
  await editKnownFix(actor, roomId, { intent: "drop", id: older.id });
  expect(
    await db.activityLog.count({ where: { entityId: older.id, action: "TicketUpdated" } }),
  ).toBe(1);
  expect((await db.ticket.findUniqueOrThrow({ where: { id: older.id } })).resolution).toBe(
    "Old help",
  );
  await db.equipment.update({ where: { id: deviceId }, data: { status: "RETIRED" } });
  expect((await states()).knownFixes.length).toBeGreaterThan(0);
  const moved = await moveKnownIssues(actor, roomId, { functionId, note: "New synthetic note" });
  expect(moved).toMatchObject({ keepAsFix: true, functionId, resolution: "New synthetic note" });
});

it("rejects a retained unresolved or unlinked ticket", async () => {
  await expect(
    createTicket(actor, ticketCreateSchema.parse({ title: "Invalid fix", keepAsFix: true })),
  ).rejects.toBeInstanceOf(ValidationError);
});
