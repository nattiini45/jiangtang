import { z } from "zod";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { NotFoundError } from "~/lib/errors.server";
import { modelPortsSchema } from "~/domains/inventory/inventory.ports.schema";

export async function setEquipmentModelPorts(
  actor: AuditActor,
  modelId: string,
  input: z.input<typeof modelPortsSchema>,
) {
  const ports = modelPortsSchema.parse(input);
  const result = await txWithAudit(
    actor,
    async (tx, audit) => {
      const rows =
        await tx.$queryRaw`SELECT id FROM "EquipmentModel" WHERE id = ${modelId} FOR UPDATE`;
      if (!(rows as unknown[]).length) throw new NotFoundError();
      await tx.equipmentModelPort.deleteMany({
        where: { modelId, label: { notIn: ports.map((port) => port.label) } },
      });
      for (const [position, port] of ports.entries()) {
        await tx.equipmentModelPort.upsert({
          where: { modelId_label: { modelId, label: port.label } },
          create: { ...port, modelId, position },
          update: { ...port, position },
        });
      }
      await audit({
        action: "EquipmentModelPortsSet",
        entityType: "equipmentModel",
        entityId: modelId,
        data: { ports },
      });
      return tx.equipmentModelPort.findMany({
        where: { modelId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
      });
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  await emitChange({ entityType: "equipmentModel", id: modelId, op: "updated" });
  return result;
}
