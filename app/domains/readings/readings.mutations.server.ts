import { z } from "zod";
import { txWithAudit, type AuditActor, type AuditFn } from "~/lib/audit.server";
import type { Tx } from "~/lib/db.server";
import { requirePermission } from "~/lib/rbac.server";
import { lockDefinitions } from "~/lib/custom-fields/definitions.server";
import { compileCustomValues } from "~/lib/custom-fields/values.server";
import { getFieldSchema } from "~/lib/custom-fields/schema.server";
import { conditionHolds } from "~/lib/custom-fields/fields";
import { NotFoundError, ValidationError } from "~/lib/errors.server";
import { tr } from "~/i18n/request-locale.server";
import { emitChange } from "~/lib/realtime/emit.server";
import type { Prisma } from "~/generated/prisma/client";

export function invalidReading() {
  return new ValidationError({}, [tr("readings.invalid")]);
}

export async function appendReadingInTx(
  tx: Tx,
  audit: AuditFn,
  actor: AuditActor,
  input: {
    equipmentId: string;
    fieldId: string;
    value: Prisma.InputJsonValue;
    observedAt: Date;
    source: "typed" | "round" | "replacement";
    sourceRef?: string;
    partModelId?: string | null;
    planId?: string;
    plannedFor?: Date;
  },
) {
  const row = await tx.equipmentReading.create({ data: { ...input, recordedById: actor.id } });
  await audit({
    action: "EquipmentReadingRecorded",
    entityType: "equipment",
    entityId: input.equipmentId,
    data: {
      readingId: row.id,
      fieldId: row.fieldId,
      value: input.value,
      observedAt: input.observedAt.toISOString(),
      source: input.source,
      sourceRef: input.sourceRef,
      partModelId: input.partModelId,
      planId: input.planId,
      plannedFor: input.plannedFor?.toISOString(),
    },
  });
  return row;
}

export async function recordReading(
  actor: AuditActor,
  raw: {
    equipmentId: string;
    fieldId: string;
    value: unknown;
    observedAt: Date;
    roundId?: string;
  },
) {
  const input = z
    .object({
      equipmentId: z.string().min(1),
      fieldId: z.string().min(1),
      value: z.unknown(),
      observedAt: z.date().refine((date) => +date <= Date.now()),
      roundId: z.string().min(1).optional(),
    })
    .safeParse(raw);
  if (!input.success) throw invalidReading();
  const row = await txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "equipment.edit", tx);
    await lockDefinitions(tx);
    if (raw.roundId) await tx.$queryRaw`SELECT id FROM "Round" WHERE id = ${raw.roundId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "Equipment" WHERE id = ${raw.equipmentId} FOR UPDATE`;
    const device = await tx.equipment.findUnique({
      where: { id: raw.equipmentId },
      include: { model: true },
    });
    if (!device) throw new NotFoundError();
    if (device.status === "RETIRED") throw invalidReading();
    if (await tx.workPlan.findUnique({ where: { fieldId: raw.fieldId } })) throw invalidReading();
    if (raw.roundId) {
      const round = await tx.round.findFirst({
        where: {
          id: raw.roundId,
          rooms: { some: { roomId: device.roomId ?? "" } },
        },
      });
      if (!round) throw invalidReading();
    }
    const fields = await getFieldSchema(
      "EQUIPMENT",
      { store: "READING", kindId: device.kindId },
      tx,
    );
    const field = fields.find((field) => field.id === raw.fieldId && !field.hidden);
    const specs = await getFieldSchema("EQUIPMENT", {}, tx);
    if (!field || !conditionHolds(field, specs, device.customValues, device.model?.customValues))
      throw invalidReading();
    const parsed = compileCustomValues([field], device.kindId, "id").safeParse({
      [field.id]: raw.value,
    });
    const value = parsed.success ? parsed.data[field.id] : null;
    if (
      value == null ||
      (typeof value === "string" && !value.trim()) ||
      (typeof value === "number" &&
        ((["h", "min", "pcs"].includes(field.unit?.key ?? "") && value < 0) ||
          (field.unit?.key === "pcs" && !Number.isSafeInteger(value)) ||
          (field.unit?.key === "%" && (value < 0 || value > 100))))
    )
      throw invalidReading();
    const previous = await tx.equipmentReading.findFirst({
      where: { equipmentId: device.id, fieldId: field.id, observedAt: { lte: raw.observedAt } },
      orderBy: [{ observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    return appendReadingInTx(tx, audit, actor, {
      equipmentId: device.id,
      fieldId: field.id,
      partModelId: previous?.partModelId,
      value,
      observedAt: raw.observedAt,
      source: raw.roundId ? "round" : "typed",
      sourceRef: raw.roundId,
    });
  });
  await emitChange({ entityType: "equipment", id: raw.equipmentId, op: "updated" });
  return row;
}
