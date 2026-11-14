import { Prisma } from "~/generated/prisma/client";
import { db, type Tx } from "~/lib/db.server";
import { tr } from "~/i18n/request-locale.server";
import { t } from "~/i18n";
import { planDefaults } from "./plans.defaults";
import { nextPlanDate, planDay } from "./plans.policy";
import { berlinDayIndex, berlinDayStartMs } from "~/lib/berlin-days";
import { roundTargets } from "~/domains/functions/rounds.queries.server";

export const planInclude = {
  rooms: { select: { id: true, name: true } },
  equipment: { select: { id: true } },
  assignee: { select: { id: true, name: true } },
  kind: { select: { id: true, name: true } },
  rounds: { select: { id: true, plannedFor: true, closedAt: true } },
} satisfies Prisma.WorkPlanInclude;

export function planTitle(plan: { systemKey: string | null; name: string }) {
  const preset = planDefaults.find((item) => item.key === plan.systemKey);
  return preset && [t("de", preset.name), t("en", preset.name)].includes(plan.name)
    ? tr(preset.name)
    : plan.name;
}

export function planBasis(plan: { systemKey: string | null; basis: string }) {
  const preset = planDefaults.find((item) => item.key === plan.systemKey);
  return preset && [t("de", preset.basis), t("en", preset.basis)].includes(plan.basis)
    ? tr(preset.basis)
    : plan.basis;
}

export async function planOccurrences(now = new Date(), planId?: string, tx: Tx = db) {
  const plans = await tx.workPlan.findMany({
    where: { enabled: true, id: planId },
    include: planInclude,
  });
  if (!plans.length) return [];
  const [semesters, devices, rooms] = await Promise.all([
    tx.semesterStart.findMany({ orderBy: { startsAt: "asc" } }),
    tx.equipment.findMany({
      where: { status: { not: "RETIRED" } },
      select: {
        id: true,
        name: true,
        assetTag: true,
        mobility: true,
        kindId: true,
        model: { select: { name: true } },
        room: { select: { id: true, name: true } },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    }),
    plans.some((plan) => plan.workType === "round") ? roundTargets() : Promise.resolve([]),
  ]);
  const readings = plans.length
    ? await tx.$queryRaw<
        {
          planId: string;
          equipmentId: string;
          observedAt: Date;
          value: Prisma.JsonValue;
        }[]
      >(Prisma.sql`SELECT DISTINCT ON ("planId", "equipmentId")
      "planId", "equipmentId", "observedAt", value FROM "EquipmentReading"
    WHERE "planId" IN (${Prisma.join(plans.map((plan) => plan.id))})
    ORDER BY "planId", "equipmentId", "observedAt" DESC, "createdAt" DESC, id DESC`)
    : [];
  return plans
    .flatMap((plan) => {
      const title = planTitle(plan);
      const targets =
        plan.workType === "round"
          ? [null]
          : devices.filter((device) =>
              plan.target === "portable"
                ? device.mobility === "POOLED"
                : plan.target === "kind"
                  ? device.kindId === plan.kindId
                  : plan.equipment.some((item) => item.id === device.id),
            );
      return targets.flatMap((device) => {
        const latest = device
          ? readings.find((row) => row.planId === plan.id && row.equipmentId === device.id)
          : null;
        const completed = plan.rounds
          .filter((round) => round.closedAt)
          .sort((a, b) => +b.closedAt! - +a.closedAt!)[0];
        const open = !device ? plan.rounds.find((round) => !round.closedAt) : null;
        const dates = plan.semester
          ? semesters
              .filter((item) => item.startsAt >= plan.startsAt)
              .map((item) => ({
                date: new Date(berlinDayStartMs(berlinDayIndex(item.startsAt) - 1)),
                anchor: item.name,
              }))
          : [
              {
                date:
                  open?.plannedFor ??
                  (latest
                    ? nextPlanDate(latest.observedAt, plan.intervalMonths!)
                    : completed
                      ? nextPlanDate(completed.closedAt!, plan.intervalMonths!)
                      : plan.startsAt),
                anchor: null,
              },
            ];
        return dates.flatMap(({ date, anchor }) => {
          if (
            plan.semester &&
            (device
              ? latest && latest.observedAt >= date
              : plan.rounds.some(
                  (round) =>
                    round.closedAt && (+round.plannedFor! === +date || round.closedAt >= date),
                ))
          )
            return [];
          const round = plan.rounds.find((row) => +row.plannedFor! === +date);
          return [
            {
              id: `${plan.id}:${device?.id ?? "round"}:${+date}`,
              planId: plan.id,
              title,
              date,
              anchor,
              due: date <= planDay(now),
              device: device
                ? {
                    id: device.id,
                    name: device.name ?? device.model?.name ?? device.assetTag ?? device.id,
                  }
                : null,
              rooms: device
                ? device.room
                  ? [device.room]
                  : []
                : plan.rooms.length
                  ? plan.rooms
                  : rooms,
              assignee: plan.assignee?.name ?? null,
              latest: latest
                ? { observedAt: latest.observedAt, passed: latest.value === true }
                : null,
              roundId: round?.id ?? null,
              href: `/plans/${plan.id}${device ? `?device=${device.id}` : ""}`,
            },
          ];
        });
      });
    })
    .sort((a, b) => +a.date - +b.date || a.id.localeCompare(b.id));
}

export async function planChoices() {
  const [rooms, equipment, kinds, users, semesters] = await Promise.all([
    roundTargets(),
    db.equipment.findMany({
      where: { status: { not: "RETIRED" } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, assetTag: true, model: { select: { name: true } } },
    }),
    db.equipmentKind.findMany({
      where: { archivedAt: null },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.user.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.semesterStart.findMany({ orderBy: { startsAt: "asc" } }),
  ]);
  return {
    rooms,
    equipment: equipment.map((device) => ({
      id: device.id,
      name: device.name ?? device.model?.name ?? device.assetTag ?? device.id,
    })),
    kinds,
    users,
    semesters,
  };
}
