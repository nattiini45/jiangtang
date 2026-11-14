import { z } from "zod";
import { txWithAudit, type AuditActor } from "~/lib/audit.server";
import { db } from "~/lib/db.server";
import { requirePermission } from "~/lib/rbac.server";
import { lockDefinitions, createInspectionFieldInTx } from "~/lib/custom-fields/definitions.server";
import { ValidationError } from "~/lib/errors.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { tr } from "~/i18n/request-locale.server";
import { appendReadingInTx } from "~/domains/readings/readings.mutations.server";
import { createTicketInTx } from "~/domains/tickets/tickets.mutations.server";
import { createRoundInTx } from "~/domains/functions/rounds.mutations.server";
import { planDate, planSchema } from "./plans.schema";
import { planDefaults } from "./plans.defaults";
import { planInclude, planOccurrences, planTitle } from "./plans.queries.server";
import { planDay } from "./plans.policy";

export function invalidPlan() {
  return new ValidationError({}, [tr("plans.invalid")]);
}

export async function savePlan(
  actor: AuditActor,
  raw: z.input<typeof planSchema>,
  id?: string,
  systemKey?: string,
) {
  const input = planSchema.safeParse(raw);
  if (!input.success) throw invalidPlan();
  const { roomIds, equipmentIds, ...data } = input.data;
  const plan = await txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "user.manage", tx);
    await lockDefinitions(tx, true);
    if (id) await tx.$queryRaw`SELECT id FROM "WorkPlan" WHERE id = ${id} FOR UPDATE`;
    if (
      data.assigneeId &&
      !(await tx.user.findFirst({ where: { id: data.assigneeId, isActive: true } }))
    )
      throw invalidPlan();
    if (
      data.kindId &&
      !(await tx.equipmentKind.findFirst({ where: { id: data.kindId, archivedAt: null } }))
    )
      throw invalidPlan();
    if (
      (await tx.room.count({ where: { id: { in: roomIds } } })) !== new Set(roomIds).size ||
      (await tx.equipment.count({
        where: { id: { in: equipmentIds }, status: { not: "RETIRED" } },
      })) !== new Set(equipmentIds).size
    )
      throw invalidPlan();
    const old = id ? await tx.workPlan.findUniqueOrThrow({ where: { id } }) : null;
    if (old && old.workType !== data.workType) throw invalidPlan();
    const relations = {
      rooms: { set: roomIds.map((id) => ({ id })) },
      equipment: { set: equipmentIds.map((id) => ({ id })) },
    };
    let row = old
      ? await tx.workPlan.update({ where: { id }, data: { ...data, ...relations } })
      : await tx.workPlan.create({
          data: {
            ...data,
            systemKey,
            rooms: { connect: roomIds.map((id) => ({ id })) },
            equipment: { connect: equipmentIds.map((id) => ({ id })) },
          },
        });
    if (row.workType === "inspection" && !row.fieldId) {
      const field = await createInspectionFieldInTx(tx, audit, row.id, row.name);
      row = await tx.workPlan.update({ where: { id: row.id }, data: { fieldId: field.id } });
    }
    await audit({
      action: old ? "WorkPlanUpdated" : "WorkPlanCreated",
      entityType: "workPlan",
      entityId: row.id,
      data: { ...data, startsAt: data.startsAt.toISOString(), roomIds, equipmentIds },
    });
    return row;
  });
  await emitChange({ entityType: "workPlan", id: plan.id, op: "updated" });
  return plan;
}

export async function enablePlanDefault(actor: AuditActor, key: string) {
  const preset = planDefaults.find((item) => item.key === key);
  if (!preset) throw invalidPlan();
  let plan = await db.workPlan.findUnique({ where: { systemKey: key } });
  if (!plan) {
    try {
      plan = await savePlan(
        actor,
        {
          ...preset,
          name: tr(preset.name),
          basis: tr(preset.basis),
          startsAt: planDay(new Date()),
          assigneeId: null,
          kindId: null,
          roomIds: [],
          equipmentIds: [],
        },
        undefined,
        key,
      );
    } catch (error) {
      plan = await db.workPlan.findUnique({ where: { systemKey: key } });
      if (!plan) throw error;
    }
  }
  await setPlanEnabled(actor, plan.id, true);
  return plan;
}

export async function setPlanEnabled(actor: AuditActor, id: string, enabled: boolean) {
  await txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "user.manage", tx);
    await tx.workPlan.update({ where: { id }, data: { enabled } });
    await audit({
      action: "WorkPlanEnabled",
      entityType: "workPlan",
      entityId: id,
      data: { enabled },
    });
  });
  await emitChange({ entityType: "workPlan", id, op: "updated" });
}

export async function saveSemester(actor: AuditActor, name: string, rawDate: string) {
  const date = planDate.safeParse(rawDate);
  if (!date.success || !name.trim() || name.length > 200) throw invalidPlan();
  const row = await txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "user.manage", tx);
    const row = await tx.semesterStart.upsert({
      where: { startsAt: date.data },
      create: { name: name.trim(), startsAt: date.data },
      update: { name: name.trim() },
    });
    await audit({
      action: "SemesterStartSet",
      entityType: "workPlan",
      entityId: row.id,
      data: { name: row.name, startsAt: row.startsAt.toISOString() },
    });
    return row;
  });
  await emitChange({ entityType: "workPlan", id: row.id, op: "updated" });
}

export async function beginPlannedRound(actor: AuditActor, planId: string, date: Date) {
  const round = await txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "room.edit", tx);
    await tx.$queryRaw`SELECT id FROM "WorkPlan" WHERE id = ${planId} FOR UPDATE`;
    const plan = await tx.workPlan.findUniqueOrThrow({
      where: { id: planId },
      include: planInclude,
    });
    if (!plan.enabled || plan.workType !== "round") throw invalidPlan();
    const existing = plan.rounds.find((row) => +row.plannedFor! === +date);
    if (existing) return existing;
    const occurrence = (await planOccurrences(new Date(), planId, tx)).find(
      (row) => +row.date === +date,
    );
    if (!occurrence) throw invalidPlan();
    return createRoundInTx(tx, audit, actor, {
      name: planTitle(plan),
      roomIds: occurrence.rooms.map((room) => room.id),
      planId,
      plannedFor: date,
    });
  });
  await emitChange({ entityType: "workPlan", id: planId, op: "updated" });
  await emitChange({ entityType: "room", id: round.id, op: "updated" });
  return round;
}

export async function recordInspection(
  actor: AuditActor,
  raw: {
    planId: string;
    equipmentId: string;
    passed: boolean;
    observedAt: Date;
    source: string;
    functionId?: string;
  },
) {
  const parsed = z
    .object({
      planId: z.string().min(1),
      equipmentId: z.string().min(1),
      passed: z.boolean(),
      observedAt: z.date().refine((date) => +date <= Date.now()),
      source: z.string().trim().min(1).max(2000),
      functionId: z.string().optional(),
    })
    .safeParse(raw);
  if (!parsed.success) throw invalidPlan();
  const input = parsed.data;
  const result = await txWithAudit(actor, async (tx, audit) => {
    await requirePermission(actor, "equipment.edit", tx);
    await lockDefinitions(tx);
    await tx.$queryRaw`SELECT id FROM "WorkPlan" WHERE id = ${input.planId} FOR UPDATE`;
    const plan = await tx.workPlan.findUniqueOrThrow({
      where: { id: input.planId },
      include: planInclude,
    });
    const initial = await tx.equipment.findUniqueOrThrow({ where: { id: input.equipmentId } });
    if (initial.roomId)
      await tx.$queryRaw`SELECT id FROM "Room" WHERE id = ${initial.roomId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Equipment" WHERE id = ${input.equipmentId} FOR UPDATE`;
    const device = await tx.equipment.findUniqueOrThrow({ where: { id: input.equipmentId } });
    if (
      !plan.enabled ||
      plan.workType !== "inspection" ||
      !plan.fieldId ||
      device.status === "RETIRED" ||
      (plan.target === "portable"
        ? device.mobility !== "POOLED"
        : plan.target === "kind"
          ? device.kindId !== plan.kindId
          : !plan.equipment.some((row) => row.id === device.id))
    )
      throw invalidPlan();
    const reading = await appendReadingInTx(tx, audit, actor, {
      equipmentId: device.id,
      fieldId: plan.fieldId,
      planId: plan.id,
      value: input.passed,
      observedAt: input.observedAt,
      source: "typed",
      sourceRef: input.source,
    });
    let ticketId: string | null = null;
    if (!input.passed) {
      const functions = device.kindId
        ? await tx.roomFunction.findMany({
            where: { archivedAt: null, kinds: { some: { kindId: device.kindId } } },
          })
        : [];
      const fn =
        functions.find((row) => row.id === input.functionId) ??
        (functions.length === 1 ? functions[0] : null);
      if (device.roomId && functions.length && !fn) throw invalidPlan();
      const fault = await createTicketInTx(tx, audit, {
        type: "INCIDENT",
        status: "OPEN",
        title: tr("plans.failedTitle", { plan: planTitle(plan) }),
        equipmentId: device.id,
        roomId: device.roomId ?? undefined,
        functionId: device.roomId ? fn?.id : undefined,
        impact: "DOWN",
        description: input.source,
        occurredAt: input.observedAt,
        reporterId: actor.id ?? undefined,
        assigneeIds: plan.assigneeId ? [plan.assigneeId] : [],
      });
      ticketId = fault.id;
    }
    return { reading, ticketId };
  });
  await emitChange({ entityType: "equipment", id: input.equipmentId, op: "updated" });
  await emitChange({ entityType: "workPlan", id: input.planId, op: "updated" });
  if (result.ticketId)
    await emitChange({ entityType: "ticket", id: result.ticketId, op: "created" });
  return result.reading;
}
