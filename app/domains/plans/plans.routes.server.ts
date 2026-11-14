import { data, redirect } from "react-router";
import { db } from "~/lib/db.server";
import type { AuthUser } from "~/lib/auth.server";
import { safeParse } from "~/lib/validation.server";
import { NotFoundError, ValidationError, toErrorResponse } from "~/lib/errors.server";
import { utcToBerlinLocal } from "~/lib/time.server";
import { planDate, planSchema } from "./plans.schema";
import {
  planBasis,
  planChoices,
  planInclude,
  planOccurrences,
  planTitle,
} from "./plans.queries.server";
import { planDefaults } from "./plans.defaults";
import {
  beginPlannedRound,
  enablePlanDefault,
  invalidPlan,
  recordInspection,
  savePlan,
  saveSemester,
  removeSemester,
  setPlanEnabled,
} from "./plans.mutations.server";

export async function plansPageData(actor: Pick<AuthUser, "role">, id?: string, deviceId?: string) {
  const [plans, choices, occurrences] = await Promise.all([
    db.workPlan.findMany({ where: { id }, include: planInclude, orderBy: { name: "asc" } }),
    planChoices(actor.role === "ADMIN"),
    planOccurrences(new Date(), id),
  ]);
  if (id && !plans.length) throw new NotFoundError();
  if (
    actor.role === "ADMIN" &&
    plans[0]?.kind &&
    !choices.kinds.some((kind) => kind.id === plans[0].kindId)
  )
    choices.kinds.push(plans[0].kind);
  const device = deviceId
    ? await db.equipment.findUnique({
        where: { id: deviceId },
        select: { id: true, kindId: true, roomId: true },
      })
    : null;
  const functions = device?.kindId
    ? await db.roomFunction.findMany({
        where: { archivedAt: null, kinds: { some: { kindId: device.kindId } } },
        select: { id: true, name: true },
      })
    : [];
  return {
    plans: plans.map((plan) => ({
      ...plan,
      name: planTitle(plan),
      basis: planBasis(plan),
      date: utcToBerlinLocal(plan.startsAt).slice(0, 10),
    })),
    choices,
    occurrences,
    defaults: planDefaults,
    admin: actor.role === "ADMIN",
    detail: !!id,
    deviceId: deviceId && occurrences.some((row) => row.device?.id === deviceId) ? deviceId : null,
    functions,
    today: utcToBerlinLocal(new Date()).slice(0, 10),
  };
}

export async function plansAction(request: Request, actor: AuthUser, id?: string, mobile = false) {
  try {
    const form = await request.formData();
    const value = (key: string) => String(form.get(key) ?? "");
    const path = `${mobile ? "/m" : ""}/plans`;
    switch (value("intent")) {
      case "default": {
        const plan = await enablePlanDefault(actor, value("key"));
        return redirect(`${path}/${plan.id}`);
      }
      case "semester":
        await saveSemester(
          actor,
          value("name"),
          value("startsAt"),
          value("semesterId") || undefined,
        );
        return { saved: true };
      case "removeSemester":
        await removeSemester(actor, value("semesterId"));
        return { saved: true };
      case "toggle":
        if (!id) throw invalidPlan();
        await setPlanEnabled(actor, id, value("enabled") === "true");
        return { saved: true };
      case "save": {
        const date = planDate.safeParse(value("startsAt"));
        if (!date.success) throw invalidPlan();
        const semester = value("schedule") === "semester";
        const parsed = safeParse(planSchema, {
          name: value("name"),
          workType: value("workType"),
          target: value("target"),
          semester,
          startsAt: date.data,
          intervalMonths: semester ? null : value("intervalMonths"),
          basis: value("basis"),
          sourceUrl: value("sourceUrl"),
          assigneeId: value("assigneeId") || null,
          kindId: value("kindId") || null,
          roomIds: form.getAll("roomIds"),
          equipmentIds: form.getAll("equipmentIds"),
        });
        if (!parsed.success) throw invalidPlan();
        const plan = await savePlan(actor, parsed.data, id);
        return redirect(`${path}/${plan.id}`);
      }
      case "start": {
        if (!id) throw invalidPlan();
        const date = planDate.safeParse(value("plannedFor"));
        if (!date.success) throw invalidPlan();
        const round = await beginPlannedRound(actor, id, date.data);
        return redirect(`${mobile ? "/m" : ""}/rounds/${round.id}`);
      }
      case "inspect": {
        if (!id || !["true", "false"].includes(value("passed"))) throw invalidPlan();
        const date = planDate.safeParse(value("observedAt"));
        if (!date.success) throw invalidPlan();
        const plannedFor = value("plannedFor") ? planDate.safeParse(value("plannedFor")) : null;
        if (plannedFor && !plannedFor.success) throw invalidPlan();
        await recordInspection(actor, {
          planId: id,
          equipmentId: value("equipmentId"),
          observedAt: date.data,
          passed: value("passed") === "true",
          source: value("source"),
          plannedFor: plannedFor?.success ? plannedFor.data : undefined,
          functionId: value("functionId") || undefined,
        });
        return { saved: true };
      }
      default:
        throw invalidPlan();
    }
  } catch (error) {
    if (error instanceof ValidationError)
      return data({ error: error.formErrors[0] }, { status: 422 });
    throw toErrorResponse(error);
  }
}
