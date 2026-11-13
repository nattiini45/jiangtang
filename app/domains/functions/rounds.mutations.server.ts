import { z } from "zod";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr, currentLocale } from "~/i18n/request-locale.server";
import library from "~/lib/equipment-kinds/library.json" with { type: "json" };
import { transitionTicketInTx } from "~/domains/tickets/tickets.mutations.server";
import { recordFunctionFaultInTx } from "~/domains/tickets/tickets.checks.server";
import { startRoundSchema, recordCheckSchema, functionStateSchema } from "./rounds.schema";
import { markRoomCheckedInTx } from "~/domains/rooms/rooms.mutations.server";
import { restoreEquipmentInTx } from "~/domains/inventory/inventory.mutations.server";

function invalid() {
  return new ValidationError({}, [tr("functions.rounds.invalid")]);
}

export async function startRound(actor: AuditActor, raw: z.input<typeof startRoundSchema>) {
  const input = startRoundSchema.parse(raw);
  const roomIds = [...new Set(input.roomIds)];
  const round = await txWithAudit(actor, async (tx, audit) => {
    if (
      (await tx.room.count({
        where: {
          id: { in: roomIds },
          equipment: {
            some: {
              status: { not: "RETIRED" },
              kind: { roomFunctions: { some: { function: { archivedAt: null } } } },
            },
          },
        },
      })) !== roomIds.length
    )
      throw invalid();
    const row = await tx.round.create({
      data: {
        name: input.name,
        startedById: actor.id,
        rooms: { create: roomIds.map((roomId) => ({ roomId })) },
      },
    });
    await audit({
      action: "RoundStarted",
      entityType: "room",
      entityId: roomIds[0],
      data: { roundId: row.id, roomIds },
    });
    return row;
  });
  await emitChange({ entityType: "room", id: roomIds[0], op: "updated" });
  return round;
}

export async function recordCheck(actor: AuditActor, raw: z.input<typeof recordCheckSchema>) {
  const input = recordCheckSchema.parse(raw);
  const note = input.note || undefined;
  const check = await txWithAudit(actor, async (tx, audit) => {
    let skippedId: string | undefined;
    const rooms = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Room" WHERE id = ${input.roomId} FOR UPDATE`;
    if (!rooms.length) throw new NotFoundError();
    if (input.roundId) {
      await tx.$queryRaw`SELECT id FROM "Round" WHERE id = ${input.roundId} FOR UPDATE`;
      if (
        !(await tx.roundRoom.findUnique({
          where: { roundId_roomId: { roundId: input.roundId, roomId: input.roomId } },
        }))
      )
        throw invalid();
      const existing = await tx.roomCheck.findUnique({
        where: {
          roundId_roomId_functionId: {
            roundId: input.roundId,
            roomId: input.roomId,
            functionId: input.functionId,
          },
        },
      });
      if (existing && existing.result !== "NOT_CHECKED") return existing;
      skippedId = existing?.id;
      if ((await tx.round.findUniqueOrThrow({ where: { id: input.roundId } })).closedAt)
        throw invalid();
    }
    await tx.$queryRaw`SELECT id FROM "Equipment" WHERE "roomId" = ${input.roomId} ORDER BY id FOR UPDATE`;
    const functions = await tx.roomFunction.findMany({
      where: {
        archivedAt: null,
        kinds: {
          some: {
            kind: { equipment: { some: { roomId: input.roomId, status: { not: "RETIRED" } } } },
          },
        },
      },
      include: { kinds: true },
    });
    const definition = functions.find((row) => row.id === input.functionId);
    if (!definition) throw invalid();
    const devices = await tx.equipment.findMany({
      where: {
        roomId: input.roomId,
        status: { not: "RETIRED" },
        kindId: { in: definition.kinds.map((kind) => kind.kindId) },
      },
    });
    let ticketId: string | undefined;
    if (input.result === "WORKS") {
      if (input.resolveFaults.length && !input.resolution) throw invalid();
      for (const id of input.resolveFaults) {
        await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${id} FOR UPDATE`;
        const fault = await tx.ticket.findFirst({
          where: {
            id,
            type: "INCIDENT",
            status: { in: ["OPEN", "IN_PROGRESS"] },
            OR: [
              { roomId: input.roomId, functionId: input.functionId },
              { functionId: null, equipmentId: { in: devices.map((device) => device.id) } },
            ],
          },
        });
        if (!fault) throw invalid();
        await transitionTicketInTx(tx, audit, id, {
          status: "RESOLVED",
          resolution: input.resolution,
          keepAsFix: !!fault.functionId,
        });
        ticketId = id;
      }
      for (const id of input.restoreDevices) {
        if (!devices.some((device) => device.id === id && device.status !== "OPERATIONAL"))
          throw invalid();
        await restoreEquipmentInTx(tx, audit, id);
      }
    } else if (input.result !== "NOT_CHECKED") {
      const name =
        (!definition.renamed &&
          library.functions.find((entry) => entry.key === definition.systemKey)?.[
            currentLocale()
          ]) ||
        definition.name;
      const fault = await recordFunctionFaultInTx(tx, audit, {
        roomId: input.roomId,
        functionId: input.functionId,
        type: "INCIDENT",
        status: "OPEN",
        channel: "ROUND",
        impact: input.result,
        reporterId: actor.id ?? undefined,
        assigneeIds: [],
        title: tr("functions.faultTitle", {
          function: name,
          impact: tr(`functions.state.${input.result}`),
        }),
        description: note,
      });
      ticketId = fault.id;
    }
    const now = new Date();
    if (input.result !== "NOT_CHECKED") {
      const overrides = await tx.functionOverride.findMany({
        where: { roomId: input.roomId, functionId: input.functionId, endedAt: null },
      });
      await tx.functionOverride.updateMany({
        where: { id: { in: overrides.map((row) => row.id) } },
        data: { endedAt: now },
      });
      for (const override of overrides)
        await audit({
          action: "FunctionStateCleared",
          entityType: "room",
          entityId: input.roomId,
          data: { overrideId: override.id, functionId: input.functionId, viaCheck: true },
        });
    }
    const data = {
      roomId: input.roomId,
      functionId: input.functionId,
      roundId: input.roundId,
      result: input.result,
      note,
      ticketId,
      checkedById: actor.id,
      checkedAt: now,
    };
    const row = skippedId
      ? await tx.roomCheck.update({ where: { id: skippedId }, data })
      : await tx.roomCheck.create({ data });
    await audit({
      action: "FunctionChecked",
      entityType: "room",
      entityId: input.roomId,
      data: {
        checkId: row.id,
        functionId: input.functionId,
        result: input.result,
        roundId: input.roundId ?? null,
      },
    });
    if (input.roundId) {
      const checks = await tx.roomCheck.findMany({
        where: { roundId: input.roundId, roomId: input.roomId, result: { not: "NOT_CHECKED" } },
      });
      if (functions.every((fn) => checks.some((check) => check.functionId === fn.id))) {
        await tx.roundRoom.update({
          where: { roundId_roomId: { roundId: input.roundId, roomId: input.roomId } },
          data: { completedAt: now },
        });
        await markRoomCheckedInTx(tx, audit, input.roomId, now);
        if (!(await tx.roundRoom.count({ where: { roundId: input.roundId, completedAt: null } })))
          await tx.round.update({ where: { id: input.roundId }, data: { closedAt: now } });
      }
    }
    return row;
  });
  await emitChange({ entityType: "room", id: input.roomId, op: "updated" });
  if (check.ticketId) await emitChange({ entityType: "ticket", id: check.ticketId, op: "updated" });
  for (const id of input.resolveFaults)
    if (id !== check.ticketId) await emitChange({ entityType: "ticket", id, op: "updated" });
  for (const id of input.restoreDevices)
    await emitChange({ entityType: "equipment", id, op: "updated" });
  return check;
}

export async function setFunctionState(
  actor: AuditActor & { role: string },
  raw: z.input<typeof functionStateSchema>,
) {
  if (actor.role !== "ADMIN") throw new Response(null, { status: 403 });
  const input = functionStateSchema.parse(raw);
  if (input.until && input.until <= new Date()) throw invalid();
  const override = await txWithAudit(actor, async (tx, audit) => {
    const rooms = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Room" WHERE id = ${input.roomId} FOR UPDATE`;
    if (!rooms.length) throw new NotFoundError();
    if (!(await tx.roomFunction.findFirst({ where: { id: input.functionId, archivedAt: null } })))
      throw invalid();
    const now = new Date();
    await tx.functionOverride.updateMany({
      where: { roomId: input.roomId, functionId: input.functionId, endedAt: null },
      data: { endedAt: now },
    });
    const row = await tx.functionOverride.create({
      data: { ...input, setById: actor.id, setAt: now },
    });
    await audit({
      action: "FunctionStateSet",
      entityType: "room",
      entityId: input.roomId,
      data: {
        overrideId: row.id,
        functionId: input.functionId,
        state: input.state,
        until: input.until?.toISOString() ?? null,
      },
    });
    return row;
  });
  await emitChange({ entityType: "room", id: input.roomId, op: "updated" });
  return override;
}

export async function clearFunctionState(
  actor: AuditActor & { role: string },
  roomId: string,
  functionId: string,
) {
  if (actor.role !== "ADMIN") throw new Response(null, { status: 403 });
  const result = await txWithAudit(actor, async (tx, audit) => {
    await tx.$queryRaw`SELECT id FROM "Room" WHERE id = ${roomId} FOR UPDATE`;
    const ended = await tx.functionOverride.updateMany({
      where: { roomId, functionId, endedAt: null },
      data: { endedAt: new Date() },
    });
    if (ended.count)
      await audit({
        action: "FunctionStateCleared",
        entityType: "room",
        entityId: roomId,
        data: { functionId },
      });
    return ended;
  });
  await emitChange({ entityType: "room", id: roomId, op: "updated" });
  return result;
}
