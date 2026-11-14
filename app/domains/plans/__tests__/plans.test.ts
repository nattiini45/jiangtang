import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import type { AuditActor } from "~/lib/audit.server";
import { txWithAudit } from "~/lib/audit.server";
import { reconcileFunctionsInTx } from "~/domains/functions/functions.library.server";
import { recordCheck } from "~/domains/functions/rounds.mutations.server";
import { getHomeDue } from "~/domains/dashboard/home.queries.server";
import { getWorkspaceCalendar, calendarChoices } from "~/domains/calendar/calendar.queries.server";
import { recordReading } from "~/domains/readings/readings.mutations.server";
import { updateCustomField } from "~/lib/custom-fields/definitions.server";
import { planOccurrences } from "../plans.queries.server";
import { nextPlanDate } from "../plans.policy";
import { planDate } from "../plans.schema";
import { plansPageData } from "../plans.routes.server";
import { groupPlanOccurrences } from "../plans.groups";
import {
  beginPlannedRound,
  recordInspection,
  savePlan,
  saveSemester,
  removeSemester,
  setPlanEnabled,
} from "../plans.mutations.server";

let actor: AuditActor,
  member: AuditActor,
  roomId: string,
  deviceId: string,
  secondId: string,
  kindId: string,
  functionId: string;
const plans: { id: string; fieldId: string | null }[] = [];
const dates = ["2025-04-01", "2025-10-01"];
const first = new Date("2025-01-30T23:00:00Z");
const now = new Date("2025-03-31T12:00:00Z");
const input = () => ({
  name: `Synthetic inspection ${randomUUID()}`,
  workType: "inspection" as const,
  target: "devices" as const,
  intervalMonths: 6,
  semester: false,
  startsAt: first,
  basis: "Synthetic manufacturer's six-month interval",
  sourceUrl: "https://example.test/manual",
  assigneeId: null,
  kindId: null,
  roomIds: [],
  equipmentIds: [deviceId, secondId],
});

beforeAll(async () => {
  actor = await db.user.create({
    data: {
      name: "Synthetic plan administrator",
      email: `${randomUUID()}@example.test`,
      role: "ADMIN",
    },
  });
  member = await db.user.create({
    data: { name: "Synthetic inspector", email: `${randomUUID()}@example.test`, role: "MEMBER" },
  });
  kindId = (await db.equipmentKind.findUniqueOrThrow({ where: { systemKey: "projector" } })).id;
  await txWithAudit(actor, reconcileFunctionsInTx);
  functionId = (
    await db.roomFunction.findFirstOrThrow({
      where: { archivedAt: null, kinds: { some: { kindId, role: "CARRIER" } } },
    })
  ).id;
  roomId = (await db.room.create({ data: { name: "Synthetic plan room", slug: randomUUID() } })).id;
  for (const name of ["Synthetic inspected projector", "Synthetic second projector"]) {
    const device = await db.equipment.create({
      data: { name, roomId, kindId, category: "PROJECTOR", mobility: "POOLED" },
    });
    if (!deviceId) deviceId = device.id;
    else secondId = device.id;
  }
});

afterAll(async () => {
  const ids = plans.map((plan) => plan.id);
  await db.$executeRaw`TRUNCATE "EquipmentReading"`;
  await db.roomCheck.deleteMany({ where: { roomId } });
  await db.round.deleteMany({ where: { planId: { in: ids } } });
  await db.ticket.deleteMany({ where: { equipmentId: { in: [deviceId, secondId] } } });
  await db.workPlan.deleteMany({ where: { id: { in: ids } } });
  await db.customField.deleteMany({
    where: { id: { in: plans.flatMap((plan) => (plan.fieldId ? [plan.fieldId] : [])) } },
  });
  await db.equipment.deleteMany({ where: { id: { in: [deviceId, secondId] } } });
  await db.room.delete({ where: { id: roomId } });
  await db.semesterStart.deleteMany({
    where: { startsAt: { in: dates.map((date) => planDate.parse(date)) } },
  });
  await db.user.deleteMany({ where: { id: { in: [actor.id!, member.id!] } } });
  await db.$disconnect();
});

describe("recurring work", () => {
  it("clamps month ends and preserves Berlin dates through leap years and DST", () => {
    expect(nextPlanDate(first, 1)).toEqual(new Date("2025-02-27T23:00:00Z"));
    expect(nextPlanDate(new Date("2024-01-31T12:00:00Z"), 1)).toEqual(
      new Date("2024-02-28T23:00:00Z"),
    );
    expect(nextPlanDate(first, 6)).toEqual(new Date("2025-07-30T22:00:00Z"));
    for (const value of ["2025-02-30", "2025-13-01", "2025-00-00", "tomorrow"])
      expect(planDate.safeParse(value).success).toBe(false);
  });

  it("keeps plans off until enabled and enforces admin configuration", async () => {
    const plan = await savePlan(actor, input());
    plans.push(plan);
    expect(await planOccurrences(now, plan.id)).toEqual([]);
    await expect(setPlanEnabled(member, plan.id, true)).rejects.toMatchObject({ status: 403 });
    await expect(savePlan(member, input())).rejects.toMatchObject({ status: 403 });
    await setPlanEnabled(actor, plan.id, true);
    expect(await planOccurrences(now, plan.id)).toHaveLength(2);
  });

  it("records a sourced append-only reading, advances only that device, and retains newer facts after a backdate", async () => {
    const plan = plans[0];
    const observedAt = new Date("2025-02-10T10:30:00Z");
    const reading = await recordInspection(member, {
      planId: plan.id,
      equipmentId: deviceId,
      passed: true,
      observedAt,
      source: "Synthetic test report 101",
    });
    expect(reading).toMatchObject({
      value: true,
      source: "typed",
      sourceRef: "Synthetic test report 101",
      planId: plan.id,
      fieldId: plan.fieldId,
      recordedById: member.id,
    });
    const rows = await planOccurrences(now, plan.id);
    expect(rows.find((row) => row.device?.id === deviceId)?.date).toEqual(
      new Date("2025-08-09T22:00:00Z"),
    );
    expect(rows.find((row) => row.device?.id === secondId)?.date).toEqual(first);
    await recordInspection(member, {
      planId: plan.id,
      equipmentId: deviceId,
      passed: true,
      observedAt: first,
      source: "Synthetic older report",
    });
    expect(
      (await planOccurrences(now, plan.id)).find((row) => row.device?.id === deviceId)?.date,
    ).toEqual(new Date("2025-08-09T22:00:00Z"));
    await expect(
      db.equipmentReading.update({ where: { id: reading.id }, data: { value: false } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      recordReading(member, {
        equipmentId: deviceId,
        fieldId: plan.fieldId!,
        value: true,
        observedAt,
      }),
    ).rejects.toThrow();
    await expect(updateCustomField(actor, { id: plan.fieldId!, type: "TEXT" })).rejects.toThrow();
    expect(
      await db.activityLog.count({
        where: { action: "EquipmentReadingRecorded", entityId: deviceId },
      }),
    ).toBe(2);
  });

  it("fails atomically for the wrong scope, missing source, future date or an ambiguous failed function", async () => {
    const plan = plans[0];
    const count = await db.equipmentReading.count({ where: { planId: plan.id } });
    for (const bad of [
      { source: "" },
      { observedAt: new Date("2099-01-01") },
      { equipmentId: "missing" },
    ]) {
      await expect(
        recordInspection(member, {
          planId: plan.id,
          equipmentId: deviceId,
          passed: true,
          observedAt: first,
          source: "Synthetic report",
          ...bad,
        }),
      ).rejects.toThrow();
    }
    expect(await db.equipmentReading.count({ where: { planId: plan.id } })).toBe(count);
  });

  it("opens a function fault on a failed device inspection and never auto-resolves it on passing", async () => {
    const plan = plans[0];
    await recordInspection(member, {
      planId: plan.id,
      equipmentId: secondId,
      passed: false,
      observedAt: first,
      source: "Synthetic failed test",
      functionId,
    });
    const fault = await db.ticket.findFirstOrThrow({ where: { equipmentId: secondId } });
    expect(fault).toMatchObject({ roomId, functionId, impact: "DOWN", status: "OPEN" });
    await recordInspection(member, {
      planId: plan.id,
      equipmentId: secondId,
      passed: true,
      observedAt: now,
      source: "Synthetic re-test",
    });
    expect((await db.ticket.findUniqueOrThrow({ where: { id: fault.id } })).status).toBe("OPEN");
  });

  it("puts semester rounds and inspection deadlines in the same calendar and home due data", async () => {
    const round = await savePlan(actor, {
      ...input(),
      name: "Synthetic semester round",
      workType: "round",
      target: "rooms",
      semester: true,
      intervalMonths: null,
      roomIds: [roomId],
      equipmentIds: [],
    });
    plans.push(round);
    await setPlanEnabled(actor, round.id, true);
    for (const date of dates) await saveSemester(actor, `Synthetic semester ${date}`, date);
    const rows = await planOccurrences(now, round.id);
    expect(rows.map((row) => row.date)).toEqual([
      new Date("2025-03-30T22:00:00Z"),
      new Date("2025-09-29T22:00:00Z"),
    ]);
    const calendar = await getWorkspaceCalendar({
      from: new Date("2025-01-01"),
      to: new Date("2026-01-01"),
      kinds: calendarChoices.map((choice) => choice.id),
    });
    expect(
      calendar.entries.filter((entry) => entry.id.startsWith(`plan:${round.id}`)),
    ).toHaveLength(2);
    expect((await getHomeDue([], now)).plans.some((row) => row.planId === round.id)).toBe(true);
    const [started, repeated] = await Promise.all([
      beginPlannedRound(actor, round.id, rows[0].date),
      beginPlannedRound(actor, round.id, rows[0].date),
    ]);
    expect(started.id).toBe(repeated.id);
    const functions = await db.roomFunction.findMany({
      where: { archivedAt: null, kinds: { some: { kindId } } },
    });
    for (const fn of functions)
      await recordCheck(member, {
        roomId,
        roundId: started.id,
        functionId: fn.id,
        result: "WORKS",
        resolveFaults: [],
        restoreDevices: [],
      });
    expect(
      (await db.round.findUniqueOrThrow({ where: { id: started.id } })).closedAt,
    ).not.toBeNull();
    expect(
      (await planOccurrences(new Date(), round.id)).every((row) => row.roundId !== started.id),
    ).toBe(true);
  });

  it("enforces the new schedule CHECK without restricting previous-release reading and round writes", async () => {
    await expect(
      db.workPlan.create({
        data: {
          name: "Synthetic invalid",
          workType: "inspection",
          target: "portable",
          startsAt: first,
          basis: "Synthetic",
          sourceUrl: "https://example.test",
        },
      }),
    ).rejects.toThrow();
    const round = await db.round.create({ data: { name: "Synthetic old-release round" } });
    expect(round.planId).toBeNull();
    await db.round.delete({ where: { id: round.id } });
  });

  it("advances a monthly round from actual completion, not from its old deadline", async () => {
    const plan = await savePlan(actor, {
      ...input(),
      workType: "round",
      target: "rooms",
      intervalMonths: 3,
      roomIds: [roomId],
      equipmentIds: [],
    });
    plans.push(plan);
    await setPlanEnabled(actor, plan.id, true);
    const round = await beginPlannedRound(actor, plan.id, first);
    expect((await plansPageData({ role: "ADMIN" }, plan.id)).deviceId).toBeNull();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2025-04-15T10:00:00Z"));
    try {
      const functions = await db.roomFunction.findMany({
        where: { archivedAt: null, kinds: { some: { kindId } } },
      });
      for (const fn of functions)
        await recordCheck(member, {
          roomId,
          roundId: round.id,
          functionId: fn.id,
          result: "WORKS",
          resolveFaults: [],
          restoreDevices: [],
        });
      expect((await planOccurrences(new Date(), plan.id))[0].date).toEqual(
        new Date("2025-07-14T22:00:00Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("records which semester inspection was completed early, independently for each device", async () => {
    const plan = await savePlan(actor, { ...input(), semester: true, intervalMonths: null });
    plans.push(plan);
    await setPlanEnabled(actor, plan.id, true);
    const occurrence = (await planOccurrences(now, plan.id)).find(
      (row) => row.device?.id === deviceId,
    )!;
    await recordInspection(member, {
      planId: plan.id,
      equipmentId: deviceId,
      passed: true,
      observedAt: new Date("2025-03-15T10:00:00Z"),
      plannedFor: occurrence.date,
      source: "Synthetic early semester report",
    });
    let rows = await planOccurrences(now, plan.id);
    expect(rows.filter((row) => row.device?.id === deviceId).map((row) => row.date)).toEqual([
      new Date("2025-09-29T22:00:00Z"),
    ]);
    expect(rows.filter((row) => row.device?.id === secondId)).toHaveLength(2);
    await recordInspection(member, {
      planId: plan.id,
      equipmentId: secondId,
      passed: true,
      observedAt: new Date("2025-04-15T10:00:00Z"),
      plannedFor: occurrence.date,
      source: "Synthetic late semester report",
    });
    rows = await planOccurrences(now, plan.id);
    expect(rows.filter((row) => row.device?.id === secondId).map((row) => row.date)).toEqual([
      new Date("2025-09-29T22:00:00Z"),
    ]);
  });

  it.each(["inspection", "round"] as const)(
    "keeps a later semester due when an older %s is completed late",
    async (workType) => {
      const plan = await savePlan(actor, {
        ...input(),
        workType,
        target: workType === "round" ? "rooms" : "devices",
        roomIds: workType === "round" ? [roomId] : [],
        equipmentIds: workType === "round" ? [] : [deviceId],
        semester: true,
        intervalMonths: null,
      });
      plans.push(plan);
      await setPlanEnabled(actor, plan.id, true);
      const before = await planOccurrences(now, plan.id);
      expect(before.map((row) => row.date)).toEqual([
        new Date("2025-03-30T22:00:00Z"),
        new Date("2025-09-29T22:00:00Z"),
      ]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2025-11-15T10:00:00Z"));
      try {
        if (workType === "inspection") {
          await recordInspection(member, {
            planId: plan.id,
            equipmentId: deviceId,
            passed: true,
            observedAt: new Date(),
            plannedFor: before[0].date,
            source: "Synthetic overdue semester report",
          });
        } else {
          const round = await beginPlannedRound(actor, plan.id, before[0].date);
          const functions = await db.roomFunction.findMany({
            where: { archivedAt: null, kinds: { some: { kindId } } },
          });
          for (const fn of functions)
            await recordCheck(member, {
              roomId,
              roundId: round.id,
              functionId: fn.id,
              result: "WORKS",
              resolveFaults: [],
              restoreDevices: [],
            });
          expect((await db.round.findUniqueOrThrow({ where: { id: round.id } })).closedAt).toEqual(
            new Date(),
          );
        }
        expect((await planOccurrences(new Date(), plan.id)).map((row) => row.date)).toEqual([
          before[1].date,
        ]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves the selected semester date in device links and page data", async () => {
    const plan = await savePlan(actor, {
      ...input(),
      equipmentIds: [deviceId],
      semester: true,
      intervalMonths: null,
    });
    plans.push(plan);
    await setPlanEnabled(actor, plan.id, true);
    const rows = await planOccurrences(now, plan.id);
    expect(rows[1].href).toBe(`/plans/${plan.id}?device=${deviceId}&plannedFor=2025-09-30`);
    const page = await plansPageData({ role: "MEMBER" }, plan.id, deviceId, "2025-09-30");
    expect(page.deviceId).toBe(deviceId);
    expect(page.plannedFor).toEqual(rows[1].date);
    await expect(
      plansPageData({ role: "MEMBER" }, plan.id, deviceId, "2025-02-30"),
    ).rejects.toMatchObject({ name: "ValidationError" });
  });

  it("groups a large fleet without losing devices or resource-filter accuracy", async () => {
    const plan = await savePlan(actor, input());
    plans.push(plan);
    await setPlanEnabled(actor, plan.id, true);
    const rows = await planOccurrences(now, plan.id);
    const grouped = groupPlanOccurrences(
      Array.from({ length: 2000 }, (_, index) => ({
        ...rows[0],
        id: `synthetic-${index}`,
        device: { id: `synthetic-${index}`, name: `Synthetic device ${index}` },
      })),
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0].count).toBe(2000);
    expect(grouped[0].equipment).toHaveLength(2000);
    expect(grouped[0].rooms).toHaveLength(1);
    const range = { from: first, to: new Date("2025-02-01T23:00:00Z"), kinds: ["plans"] };
    const all = await getWorkspaceCalendar({ ...range, roomId });
    expect(
      all.entries.find((entry) => entry.id.startsWith(`plan:${plan.id}`))?.equipment,
    ).toHaveLength(2);
    const single = await getWorkspaceCalendar({ ...range, equipmentId: deviceId });
    expect(
      single.entries.find((entry) => entry.id.startsWith(`plan:${plan.id}`))?.equipment,
    ).toEqual([{ id: deviceId, name: "Synthetic inspected projector" }]);
    expect((await plansPageData({ role: "MEMBER" }, plan.id)).choices.users).toEqual([]);
  });

  it("lets an admin correct and remove a mistaken semester without direct database access", async () => {
    await saveSemester(actor, "Synthetic editable semester", "2060-04-01");
    const row = await db.semesterStart.findUniqueOrThrow({
      where: { startsAt: planDate.parse("2060-04-01") },
    });
    await expect(removeSemester(member, row.id)).rejects.toMatchObject({ status: 403 });
    await saveSemester(actor, "Synthetic corrected semester", "2060-04-02", row.id);
    expect((await db.semesterStart.findUniqueOrThrow({ where: { id: row.id } })).startsAt).toEqual(
      planDate.parse("2060-04-02"),
    );
    await removeSemester(actor, row.id);
    expect(await db.semesterStart.findUnique({ where: { id: row.id } })).toBeNull();
    expect(
      await db.activityLog.count({ where: { entityType: "semesterStart", entityId: row.id } }),
    ).toBe(3);
  });
});
