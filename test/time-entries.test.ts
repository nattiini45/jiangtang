import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { berlinLocalToUtc } from "~/lib/time.server";
import { ValidationError } from "~/lib/errors.server";
import {
  createTimeEntry,
  deleteTimeEntry,
  startTimer,
  stopTimer,
  updateTimeEntry,
} from "~/domains/time/time.mutations.server";
import { getRunningEntry, getWeekTimesheet } from "~/domains/time/time.queries.server";
import { isoWeekRange, dayIndexToIsoWeek, berlinDayIndex } from "~/lib/berlin-days";
import type { AuditActor } from "~/lib/audit.server";
import { runWithLocale } from "~/i18n/request-locale.server";

/**
 * TimeEntry domain + folded SQL invariants. Runs against the dev DB with
 * RUN-prefixed fixtures; cleanup deletes entries/tasks/users it created. The
 * two folded 09 artefacts are exercised through the real engine: the CHECK via
 * a rejected insert, the one-running-timer partial index via a second running
 * row hitting P2002 → friendly ValidationError.
 */

const RUN = `time_entries_${Date.now().toString(36)}`;
const B = berlinLocalToUtc;

const member: AuditActor & { role: "MEMBER" } = {
  id: "",
  name: `${RUN} Member`,
  email: `${RUN}-m@t.local`,
  initials: "BM",
  role: "MEMBER",
};
const other: AuditActor & { role: "MEMBER" } = {
  id: "",
  name: `${RUN} Other`,
  email: `${RUN}-o@t.local`,
  initials: "BO",
  role: "MEMBER",
};
const admin: AuditActor & { role: "ADMIN" } = {
  id: "",
  name: `${RUN} Admin`,
  email: `${RUN}-a@t.local`,
  initials: "BA",
  role: "ADMIN",
};

let taskId = "";
const entryIds: string[] = [];

beforeAll(async () => {
  for (const a of [member, other, admin]) {
    const u = await db.user.create({
      data: { name: a.name!, email: a.email!, initials: a.initials, role: a.role },
    });
    a.id = u.id;
  }
  const task = await db.task.create({ data: { title: `${RUN} Aufgabe`, status: "IN_PROGRESS" } });
  taskId = task.id;
});

afterAll(async () => {
  await db.timeEntry.deleteMany({ where: { userId: { in: [member.id!, other.id!, admin.id!] } } });
  await db.task.delete({ where: { id: taskId } }).catch(() => undefined);
  for (const a of [member, other, admin]) {
    await db.user.delete({ where: { id: a.id! } }).catch(() => undefined);
  }
  await db.$disconnect();
});

const input = (over: Partial<Parameters<typeof createTimeEntry>[1]> = {}) => {
  const merged = {
    startsAt: B("2026-10-06T09:00"),
    endsAt: B("2026-10-06T10:30"),
    taskId,
    comment: null,
    ...over,
  };
  return { ...merged, taskId: merged.taskId ?? undefined };
};

describe("TimeEntry constraints (in the migration chain)", () => {
  it("the CHECK refuses endsAt <= startsAt", async () => {
    await expect(
      db.timeEntry.create({
        data: {
          userId: member.id!,
          startsAt: B("2026-10-06T10:00"),
          endsAt: B("2026-10-06T10:00"),
        },
      }),
    ).rejects.toThrow();
  });

  it("the partial unique index allows only one running entry per user", async () => {
    const e = await startTimer(member, taskId);
    entryIds.push(e.id);
    // Same user, second running row — refused by the domain pre-check…
    await expect(startTimer(member)).rejects.toThrow(ValidationError);
    // …and at the database level by the partial index (defense in depth).
    await expect(
      db.timeEntry.create({ data: { userId: member.id!, startsAt: new Date() } }),
    ).rejects.toThrow();
    // Another user may run their own timer concurrently.
    const otherTimer = await startTimer(other, taskId);
    entryIds.push(otherTimer.id);
    await stopTimer(other);
    await stopTimer(member);
  });
});

describe("timer + entry mutations", () => {
  it("start/stop writes audited entries; a second start while running is refused", async () => {
    const e = await startTimer(member, taskId);
    entryIds.push(e.id);
    expect(e.endsAt).toBeNull();
    expect(await getRunningEntry(member.id!)).not.toBeNull();
    await expect(startTimer(member)).rejects.toMatchObject({
      name: "ValidationError",
      formErrors: ["Es läuft bereits ein Timer — zuerst stoppen."],
    });
    const stopped = await stopTimer(member);
    expect(stopped.endsAt).not.toBeNull();
    expect(await getRunningEntry(member.id!)).toBeNull();
    await expect(stopTimer(member)).rejects.toMatchObject({
      name: "ValidationError",
      formErrors: ["Es läuft kein Timer."],
    });

    const audit = await db.activityLog.findMany({
      where: { entityType: "timeEntry", entityId: e.id },
      orderBy: { occurredAt: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual(["TimeEntryStarted", "TimeEntryStopped"]);
  });

  it("create/update/delete are audited; members cannot touch others' entries, admins can", async () => {
    const e = await createTimeEntry(member, input());
    entryIds.push(e.id);
    expect(e.userId).toBe(member.id);

    await expect(updateTimeEntry(other, e.id, input({ comment: "fremd" }))).rejects.toMatchObject({
      name: "ValidationError",
    });
    await expect(deleteTimeEntry(other, e.id)).rejects.toMatchObject({
      name: "ValidationError",
    });

    const updated = await updateTimeEntry(admin, e.id, input({ comment: "admin edit" }));
    expect(updated.comment).toBe("admin edit");

    // A no-op update writes nothing — no second audit row.
    const countBefore = await db.activityLog.count({
      where: { entityType: "timeEntry", entityId: e.id, action: "TimeEntryUpdated" },
    });
    await updateTimeEntry(admin, e.id, input({ comment: "admin edit" }));
    const countAfter = await db.activityLog.count({
      where: { entityType: "timeEntry", entityId: e.id, action: "TimeEntryUpdated" },
    });
    expect(countAfter).toBe(countBefore);

    // Members cannot file under someone else; admins can.
    const sneaky = await createTimeEntry(member, input({ userId: other.id! }));
    entryIds.push(sneaky.id);
    expect(sneaky.userId).toBe(member.id);
    const filed = await createTimeEntry(admin, input({ userId: other.id! }));
    entryIds.push(filed.id);
    expect(filed.userId).toBe(other.id);

    await deleteTimeEntry(member, e.id);
    const audit = await db.activityLog.findMany({
      where: { entityType: "timeEntry", entityId: e.id },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    });
    expect(audit.map((a) => a.action)).toEqual([
      "TimeEntryCreated",
      "TimeEntryUpdated",
      "TimeEntryDeleted",
    ]);
  });

  it("an inverted interval is refused before the database", async () => {
    await expect(
      createTimeEntry(
        member,
        input({ startsAt: B("2026-10-06T12:00"), endsAt: B("2026-10-06T10:00") }),
      ),
    ).rejects.toThrow();
  });
});

describe("getWeekTimesheet", () => {
  it("rows per task, day totals as union (overlaps count once)", async () => {
    // W42 (2026-10-12 … 18) — a week no earlier fixture writes to.
    const week = "2026-W42";
    // 10:00–12:00 and 11:00–13:00 on Tuesday → raw 4 h, union 3 h.
    for (const [s, e] of [
      ["2026-10-13T10:00", "2026-10-13T12:00"],
      ["2026-10-13T11:00", "2026-10-13T13:00"],
      ["2026-10-14T22:00", "2026-10-15T01:00"], // crosses midnight: 2 h Wed + 1 h Thu
    ] as const) {
      const entry = await createTimeEntry(member, input({ startsAt: B(s), endsAt: B(e) }));
      entryIds.push(entry.id);
    }
    // An entry with no task lands in „Ohne Aufgabe".
    const loose = await createTimeEntry(
      member,
      input({ taskId: undefined, startsAt: B("2026-10-16T09:00"), endsAt: B("2026-10-16T10:00") }),
    );
    entryIds.push(loose.id);

    const sheet = await getWeekTimesheet(member.id!, week);
    const taskRow = sheet.rows.find((r) => r.taskId === taskId)!;
    // Tuesday = column 1 (Mo=0): raw per-task sum is 240 min.
    expect(taskRow.cells[1]).toBe(240);
    expect(taskRow.cells[2]).toBe(120); // Wed 22:00–24:00
    expect(taskRow.cells[3]).toBe(60); // Thu 00:00–01:00
    const freeRow = sheet.rows.find((r) => r.taskId === null)!;
    expect(freeRow.cells[4]).toBe(60); // Friday
    expect(freeRow.taskTitle).toBe("Ohne Aufgabe");
    const enSheet = await runWithLocale("en", () => getWeekTimesheet(member.id!, week));
    expect(enSheet.rows.find((r) => r.taskId === null)!.taskTitle).toBe("No task");

    // Totals merge overlaps: Tuesday union is 180, not 240.
    expect(sheet.dayTotals[1]).toBe(180);
    expect(sheet.weekTotal).toBe(180 + 120 + 60 + 60);
    // Task row total stays raw (labelled in the UI).
    expect(taskRow.total).toBe(240 + 120 + 60);
  });

  it("a running timer counts up to `now`, clipped to the week", async () => {
    const week = "2026-W41";
    const e = await createTimeEntry(member, {
      startsAt: B("2026-10-08T08:00"),
      endsAt: null, // running
      taskId,
      comment: null,
    });
    entryIds.push(e.id);
    const sheet = await getWeekTimesheet(member.id!, week, B("2026-10-08T10:00"));
    const row = sheet.rows.find((r) => r.taskId === taskId)!;
    // includes the earlier fixtures too; just assert the running part landed.
    expect(row.cells[3]).toBeGreaterThanOrEqual(120);
    await stopTimerSafe(member.id!, e.id);
  });
});

/** Stop a specific running entry without a second domain call site. */
async function stopTimerSafe(userId: string, id: string) {
  await db.timeEntry.update({ where: { id }, data: { endsAt: new Date() } }).catch(() => undefined);
}

describe("isoWeekRange bucketing (Berlin boundaries)", () => {
  it("week 41 columns land on the right civil dates", () => {
    const { startDay } = isoWeekRange("2026-W41");
    expect(dayIndexToIsoWeek(startDay)).toBe("2026-W41");
    expect(dayIndexToIsoWeek(startDay + 6)).toBe("2026-W41");
    expect(dayIndexToIsoWeek(startDay + 7)).toBe("2026-W42");
    expect(berlinDayIndex(B("2026-10-05T00:30"))).toBe(startDay);
  });
});
