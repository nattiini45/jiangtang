import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import type { Tx } from "~/lib/db.server";
import { NotFoundError, ValidationError, hasSqlState } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { tr } from "~/i18n/request-locale.server";
import { equipmentPortSchema, MAX_PORT_POSITION, type PortInput } from "./inventory.ports.schema";
import { lockKindStructure } from "~/lib/equipment-kinds/kinds.server";

export async function copyModelPortsInTx(tx: Tx, equipmentId: string, modelId: string | null) {
  if (!modelId) return [];
  await tx.$queryRaw`SELECT id FROM "EquipmentModel" WHERE id = ${modelId} FOR SHARE`;
  const ports = await tx.equipmentModelPort.findMany({
    where: { modelId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
  });
  const existing = await tx.equipmentPort.findMany({
    where: { equipmentId },
    select: { label: true, position: true },
  });
  const labels = new Set(existing.map((port) => port.label));
  const start = existing.length ? Math.max(...existing.map((port) => port.position)) + 1 : 0;
  const copies = ports
    .filter((port) => !labels.has(port.label))
    .map((port, index) => ({
      equipmentId,
      modelPortId: port.id,
      label: port.label,
      connector: port.connector,
      direction: port.direction,
      signal: port.signal,
      position: start + index,
    }));
  if (copies.some((port) => port.position > MAX_PORT_POSITION))
    throw new ValidationError({}, [tr("ports.positionFull")]);
  await tx.equipmentPort.createMany({ data: copies });
  return copies;
}

export async function lockEquipmentPorts(tx: Tx, equipmentId: string) {
  const rows = await tx.$queryRaw`SELECT id FROM "Equipment" WHERE id = ${equipmentId} FOR UPDATE`;
  if (!(rows as unknown[]).length) throw new NotFoundError();
}

export async function mutateEquipmentPort(
  actor: AuditActor,
  equipmentId: string,
  operation: "add" | "update" | "remove" | "inherit",
  input?: PortInput,
  portId?: string,
) {
  const data = input ? equipmentPortSchema.parse(input) : undefined;
  let result;
  try {
    result = await txWithAudit(actor, async (tx, audit) => {
      if (operation === "inherit") await lockKindStructure(tx);
      await lockEquipmentPorts(tx, equipmentId);
      const port = portId
        ? await tx.equipmentPort.findFirst({ where: { id: portId, equipmentId } })
        : null;
      if ((operation === "update" || operation === "remove") && !port) throw new NotFoundError();
      let changed;
      let copiedLabels: string[] | undefined;
      if (operation === "inherit") {
        const equipment = await tx.equipment.findUniqueOrThrow({ where: { id: equipmentId } });
        const copies = await copyModelPortsInTx(tx, equipmentId, equipment.modelId);
        if (copies.length === 0) return { id: equipmentId, unchanged: true };
        copiedLabels = copies.map((copy) => copy.label);
      } else if (operation === "remove") {
        const end = await tx.equipmentConnectionEnd.findUnique({
          where: { portId: port!.id },
          include: {
            connection: {
              include: {
                ends: {
                  include: {
                    port: {
                      include: { equipment: { select: { name: true, assetTag: true, id: true } } },
                    },
                  },
                },
              },
            },
          },
        });
        const other = end?.connection.ends.find((entry) => entry.portId !== port!.id)?.port;
        if (other)
          throw new ValidationError({}, [
            tr("ports.connectedRemove", {
              device: other.equipment.name ?? other.equipment.assetTag ?? other.equipment.id,
              port: other.label,
            }),
          ]);
        changed = await tx.equipmentPort.delete({ where: { id: port!.id } });
      } else {
        if (!data) throw new ValidationError({ label: [tr("ports.required")] });
        changed =
          operation === "add"
            ? await tx.equipmentPort.create({
                data: { ...data, note: data.note ?? null, equipmentId },
              })
            : await tx.equipmentPort.update({
                where: { id: port!.id },
                data: { ...data, note: data.note ?? null },
              });
      }
      await audit({
        action: portAuditActions[operation],
        entityType: "equipment",
        entityId: equipmentId,
        data: copiedLabels
          ? { labels: copiedLabels }
          : { portId: changed?.id, before: port, port: changed },
      });
      return changed ?? { id: equipmentId };
    });
  } catch (error) {
    if (hasSqlState(error, "P2002")) throw new ValidationError({ label: [tr("ports.duplicate")] });
    throw error;
  }
  if (!("unchanged" in result))
    await emitChange({ entityType: "equipment", id: equipmentId, op: "updated" });
  return result;
}

const portAuditActions = {
  add: "EquipmentPortAdded",
  update: "EquipmentPortUpdated",
  remove: "EquipmentPortRemoved",
  inherit: "EquipmentPortInherited",
} as const;
