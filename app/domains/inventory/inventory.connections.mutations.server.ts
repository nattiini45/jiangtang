import { z } from "zod";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { NotFoundError, ValidationError, hasSqlState } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { tr } from "~/i18n/request-locale.server";
import { connectPortsSchema } from "./inventory.ports.schema";
import { lockEquipmentPorts } from "./inventory.ports.mutations.server";

export async function connectEquipmentPorts(
  actor: AuditActor,
  raw: z.input<typeof connectPortsSchema>,
) {
  const input = connectPortsSchema.parse(raw);
  if (input.equipmentId === input.targetEquipmentId)
    throw new ValidationError({}, [tr("ports.sameDevice")]);
  let result;
  try {
    result = await txWithAudit(actor, async (tx, audit) => {
      for (const id of [input.equipmentId, input.targetEquipmentId].sort())
        await lockEquipmentPorts(tx, id);
      const source = await tx.equipmentPort.findFirst({
        where: { id: input.portId, equipmentId: input.equipmentId },
        include: { connectionEnd: true },
      });
      if (!source) throw new NotFoundError();
      if (source.connectionEnd) throw new ValidationError({}, [tr("ports.connectionBusy")]);
      let target;
      if (input.newPort) {
        if (
          await tx.equipmentPort.findUnique({
            where: {
              equipmentId_label: {
                equipmentId: input.targetEquipmentId,
                label: input.newPort.label,
              },
            },
          })
        )
          throw new ValidationError({ label: [tr("ports.duplicate")] });
        target = await tx.equipmentPort.create({
          data: { ...input.newPort, equipmentId: input.targetEquipmentId },
        });
        await audit({
          action: "EquipmentPortAdded",
          entityType: "equipment",
          entityId: input.targetEquipmentId,
          data: { port: target },
        });
      } else {
        target = await tx.equipmentPort.findFirst({
          where: { id: input.targetPortId, equipmentId: input.targetEquipmentId },
          include: { connectionEnd: true },
        });
        if (!target) throw new NotFoundError();
        if (target.connectionEnd) throw new ValidationError({}, [tr("ports.connectionBusy")]);
      }
      const connection = await tx.equipmentConnection.create({
        data: {
          note: input.note || null,
          ends: {
            create: [
              { portId: source.id, equipmentId: source.equipmentId },
              { portId: target.id, equipmentId: target.equipmentId },
            ],
          },
        },
      });
      for (const port of [source, target])
        await audit({
          action: "EquipmentPortsConnected",
          entityType: "equipment",
          entityId: port.equipmentId,
          data: {
            connectionId: connection.id,
            portIds: [source.id, target.id],
            note: connection.note,
          },
        });
      return connection;
    });
  } catch (error) {
    if (hasSqlState(error, "P2002")) throw new ValidationError({}, [tr("ports.connectionBusy")]);
    throw error;
  }
  for (const id of [input.equipmentId, input.targetEquipmentId])
    await emitChange({ entityType: "equipment", id, op: "updated" });
  return result;
}

export async function disconnectEquipmentPorts(
  actor: AuditActor,
  equipmentId: string,
  connectionId: string,
) {
  const result = await txWithAudit(actor, async (tx, audit) => {
    const connection = await tx.equipmentConnection.findUnique({
      where: { id: connectionId },
      include: { ends: true },
    });
    if (!connection || !connection.ends.some((end) => end.equipmentId === equipmentId))
      throw new NotFoundError();
    for (const id of connection.ends.map((end) => end.equipmentId).sort())
      await lockEquipmentPorts(tx, id);
    if (!(await tx.equipmentConnection.findUnique({ where: { id: connectionId } })))
      throw new NotFoundError();
    await tx.equipmentConnection.delete({ where: { id: connectionId } });
    for (const end of connection.ends)
      await audit({
        action: "EquipmentPortsDisconnected",
        entityType: "equipment",
        entityId: end.equipmentId,
        data: {
          connectionId,
          portIds: connection.ends.map((entry) => entry.portId),
          note: connection.note,
        },
      });
    return connection;
  });
  for (const end of result.ends)
    await emitChange({ entityType: "equipment", id: end.equipmentId, op: "updated" });
  return result;
}
