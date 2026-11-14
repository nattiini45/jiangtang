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
import {
  beginPlannedRound,
  recordInspection,
  savePlan,
  saveSemester,
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
});
