import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { berlinLocalToUtc } from "~/lib/time.server";
import { getCapacityOverview } from "~/domains/tasks/tasks.queries.server";
import { findUser, updateUser } from "~/domains/auth/users.queries.server";
import { createTimeEntry } from "~/domains/time/time.mutations.server";
import { berlinDayIndex, dayIndexToDateKey, isoWeekNumber, isoWeekStart } from "~/lib/berlin-days";
import type { AuditActor } from "~/lib/audit.server";

/**
 * Capacity overview against the real DB. RUN-prefixed fixtures, cleaned
 * in afterAll. Covers what the pure module cannot: the active-user filter,
 * the unioned current-week TimeEntry minutes, and the admin capacity write
 * (hours → minutes round-trip through `updateUser`).
 */

const RUN = `capacity_${Date.now().toString(36)}`;

const member: AuditActor & { role: "MEMBER" } = {
  id: "",
  name: `${RUN} Member`,
  email: `${RUN}-m@t.local`,
  initials: "CM",
  role: "MEMBER",
};
const inactive: AuditActor & { role: "MEMBER" } = {
  id: "",
  name: `${RUN} Inactive`,
  email: `${RUN}-i@t.local`,
  initials: "CI",
  role: "MEMBER",
};
const admin: AuditActor & { role: "ADMIN" } = {
  id: "",
  name: `${RUN} Admin`,
  email: `${RUN}-a@t.local`,
  initials: "CA",
  role: "ADMIN",
};

const taskIds: string[] = [];

beforeAll(async () => {
  for (const a of [member, inactive, admin]) {
    const u = await db.user.create({
      data: {
        name: a.name!,
        email: a.email!,
        initials: a.initials,
        role: a.role,
        isActive: a !== inactive,
      },
    });
    a.id = u.id;
  }
});

afterAll(async () => {
  await db.timeEntry.deleteMany({
    where: { userId: { in: [member.id!, inactive.id!, admin.id!] } },
  });
  for (const id of taskIds) {
    await db.task.delete({ where: { id } }).catch(() => undefined);
  }
  for (const a of [member, inactive, admin]) {
    await db.user.delete({ where: { id: a.id! } }).catch(() => undefined);
  }
  await db.$disconnect();
});

const thisMonday = () => {
  const day = berlinDayIndex(new Date());
  return dayIndexToDateKey(isoWeekStart(day));
};

describe("getCapacityOverview — user axis", () => {
  it("lists only active users; an inactive account never appears", async () => {
    const overview = await getCapacityOverview(member);
    const ids = overview.rows.map((r) => r.userId);
    expect(ids).toContain(member.id);
    expect(ids).toContain(admin.id);
    expect(ids).not.toContain(inactive.id);
  });

  it("returns 6 weeks starting with the current Berlin ISO week", async () => {
    const overview = await getCapacityOverview(member);
    expect(overview.weeks).toHaveLength(6);
    const today = berlinDayIndex(new Date());
    expect(isoWeekStart(today)).toBe(overview.weeks[0]!.startDay);
    // Labels are real ISO weeks — regenerate them and compare.
    for (let i = 0; i < 6; i++) {
      const { year, week } = isoWeekNumber(overview.weeks[i]!.startDay);
      expect(overview.weeks[i]!.isoWeek).toBe(`${year}-W${String(week).padStart(2, "0")}`);
    }
  });
});

describe("getCapacityOverview — demand and logged minutes", () => {
  it("buckets a task due this week into week 0 and an undated task into ohne Termin", async () => {
    const monday = thisMonday();
    const due = await db.task.create({
      data: {
        title: `${RUN} fällig`,
        status: "TODO",
        estimateMinutes: 120,
        dueAt: berlinLocalToUtc(`${monday}T09:00`),
        assignees: { create: [{ userId: member.id!, estimateMinutes: 90 }] },
      },
    });
    const undated = await db.task.create({
      data: {
        title: `${RUN} ohne Termin`,
        status: "TODO",
        estimateMinutes: 60,
        assignees: { create: [{ userId: member.id! }] },
      },
    });
    taskIds.push(due.id, undated.id);

    const overview = await getCapacityOverview(member);
    const row = overview.rows.find((r) => r.userId === member.id);
    expect(row).toBeDefined();
    // Assignee estimate wins over the task estimate.
    expect(row!.weeks[0]!.demand).toBeGreaterThanOrEqual(90);
    expect(row!.noDue).toBeGreaterThanOrEqual(60);
    expect(row!.noDueCount).toBeGreaterThanOrEqual(1);
  });

  it("counts overlapping TimeEntries of the current week once", async () => {
    const monday = thisMonday();
    await createTimeEntry(member, {
      startsAt: berlinLocalToUtc(`${monday}T08:00`),
      endsAt: berlinLocalToUtc(`${monday}T10:00`),
    });
    await createTimeEntry(member, {
      startsAt: berlinLocalToUtc(`${monday}T09:00`),
      endsAt: berlinLocalToUtc(`${monday}T11:00`),
    });

    const overview = await getCapacityOverview(member);
    const row = overview.rows.find((r) => r.userId === member.id);
    // 08:00–10:00 ∪ 09:00–11:00 = 180 min, not 240.
    expect(row!.weeks[0]!.logged).toBe(180);
    // Overlaps of an earlier week must not leak into the current cell.
    expect(row!.weeks[1]!.logged).toBeUndefined();
  });
});

describe("updateUser — weekly capacity", () => {
  it("persists hours as minutes and round-trips through findUser/listUsers", async () => {
    await updateUser(
      member.id!,
      {
        role: "MEMBER",
        initials: "cm",
        isActive: true,
        weeklyCapacityHours: 22.5,
      },
      admin,
    );
    const found = await findUser(member.id!);
    expect(found.weeklyCapacityMinutes).toBe(1350);

    const overview = await getCapacityOverview(member);
    const row = overview.rows.find((r) => r.userId === member.id);
    expect(row!.capacityMinutes).toBe(1350);
  });

  it("null clears the capacity back to unset (unset ≠ 0)", async () => {
    await updateUser(
      member.id!,
      { role: "MEMBER", initials: "CM", isActive: true, weeklyCapacityHours: null },
      admin,
    );
    const found = await findUser(member.id!);
    expect(found.weeklyCapacityMinutes).toBeNull();

    const overview = await getCapacityOverview(member);
    const row = overview.rows.find((r) => r.userId === member.id);
    expect(row!.capacityMinutes).toBeNull();
    expect(row!.weeks.every((w) => !w.over)).toBe(true);
  });
});
