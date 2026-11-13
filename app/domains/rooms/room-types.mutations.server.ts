import { z } from "zod";
import type { Tx } from "~/lib/db.server";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import {
  expectedFunctionIds,
  legacyFunctionFlags,
  servedFunctionIds,
} from "~/domains/functions/functions.expectations";
import { expectationSchema, setRoomTypeSchema } from "./room-types.schema";

export async function syncLegacyFunctionFlagsInTx(tx: Tx, roomId: string) {
  const room = await tx.room.findUniqueOrThrow({
    where: { id: roomId },
    include: {
      roomType: { include: { functions: true } },
      functionExpectations: true,
      equipment: { where: { status: { not: "RETIRED" } }, select: { kindId: true, status: true } },
    },
  });
  const functions = await tx.roomFunction.findMany({
    where: { archivedAt: null },
    include: { kinds: true },
  });
  const expected = expectedFunctionIds(room, servedFunctionIds(functions, room.equipment));
  const data = Object.fromEntries(
    Object.entries(legacyFunctionFlags).map(([key, flag]) => [
      flag,
      functions.some((fn) => fn.systemKey === key && expected.has(fn.id)),
    ]),
  );
  return tx.room.update({ where: { id: roomId }, data });
}

export async function applyRoomExpectationsInTx(
  tx: Tx,
  audit: AuditFn,
  roomId: string,
  input: { roomTypeId?: string | null; expectations?: z.infer<typeof expectationSchema>[] },
) {
  const rooms = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "Room" WHERE id = ${roomId} FOR UPDATE`;
  if (!rooms.length) throw new NotFoundError();
  if (
    input.roomTypeId &&
    !(await tx.roomType.findFirst({ where: { id: input.roomTypeId, archivedAt: null } }))
  )
    throw new ValidationError({ roomTypeId: [tr("functions.types.invalid")] });
  if (input.roomTypeId !== undefined) {
    await tx.room.update({ where: { id: roomId }, data: { roomTypeId: input.roomTypeId } });
  }
  for (const row of input.expectations ?? []) {
    if (!(await tx.roomFunction.findFirst({ where: { id: row.functionId, archivedAt: null } })))
      throw new ValidationError({ expectations: [tr("functions.types.invalid")] });
    if (row.expected === null) {
      await tx.roomFunctionExpectation.deleteMany({
        where: { roomId, functionId: row.functionId },
      });
    } else {
      const data = { expected: row.expected, note: row.note || null };
      await tx.roomFunctionExpectation.upsert({
        where: { roomId_functionId: { roomId, functionId: row.functionId } },
        create: { roomId, functionId: row.functionId, ...data },
        update: data,
      });
    }
  }
  const room = await syncLegacyFunctionFlagsInTx(tx, roomId);
  await audit({
    action: "RoomExpectationsChanged",
    entityType: "room",
    entityId: roomId,
    data: {
      roomTypeId: room.roomTypeId,
      functions: (input.expectations ?? []).map((row) => ({
        functionId: row.functionId,
        expected: row.expected,
      })),
    },
  });
  return room;
}

export async function setRoomType(actor: AuditActor, raw: z.input<typeof setRoomTypeSchema>) {
  const input = setRoomTypeSchema.parse(raw);
  const ids = [...new Set(input.roomIds)].sort();
  await txWithAudit(
    actor,
    async (tx, audit) => {
      for (const id of ids)
        await applyRoomExpectationsInTx(tx, audit, id, { roomTypeId: input.roomTypeId });
    },
    { timeout: 30000 },
  );
  for (const id of ids) await emitChange({ entityType: "room", id, op: "updated" });
  return { roomIds: ids, roomTypeId: input.roomTypeId };
}

export async function setFunctionExpected(
  actor: AuditActor,
  roomId: string,
  raw: z.input<typeof expectationSchema>,
) {
  const row = expectationSchema.parse(raw);
  const room = await txWithAudit(actor, (tx, audit) =>
    applyRoomExpectationsInTx(tx, audit, roomId, { expectations: [row] }),
  );
  await emitChange({ entityType: "room", id: roomId, op: "updated" });
  return room;
}
