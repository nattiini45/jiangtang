import { describe, expect, it } from "vitest";
import { computeCapacity, taskShare, type CapacityTask, type CapacityUser } from "../capacity";
import { isoWeekRange } from "~/lib/berlin-days";
import { berlinLocalToUtc } from "~/lib/time.server";

/**
 * Pure capacity math. Weeks are pinned to W41+ of 2026
 * (Mon 2026-10-05 …) so the Berlin-boundary cases are deterministic; the DST
 * week 2026-W44 (the 25 h Sunday 2026-10-25) is covered explicitly.
 */

const W41 = isoWeekRange("2026-W41");
const WEEKS = [0, 1, 2, 3, 4, 5].map((i) => ({
  isoWeek: `2026-W${41 + i}`,
  startDay: W41.startDay + i * 7,
}));
const NO_LOGGED = new Map<string, number>();

const user = (over: Partial<CapacityUser> = {}): CapacityUser => ({
  id: "u1",
  name: "Ada",
  initials: "AD",
  weeklyCapacityMinutes: 2400,
  ...over,
});

const task = (over: Partial<CapacityTask> = {}): CapacityTask => ({
  id: "t1",
  title: "Task",
  status: "IN_PROGRESS",
  dueAt: null,
  estimateMinutes: null,
  assignees: [{ userId: "u1", estimateMinutes: null }],
  ...over,
});

const run = (tasks: CapacityTask[], users: CapacityUser[] = [user()]) =>
  computeCapacity({ users, tasks, weeks: WEEKS, loggedCurrentWeek: NO_LOGGED });

describe("taskShare — apportionment", () => {
  it("prefers the assignee-level estimate", () => {
    const t = task({
      estimateMinutes: 600,
      assignees: [
        { userId: "u1", estimateMinutes: 120 },
        { userId: "u2", estimateMinutes: null },
      ],
    });
    expect(taskShare(t, "u1")).toBe(120);
  });

  it("falls back to the task estimate ÷ assignee count", () => {
    const t = task({
      estimateMinutes: 600,
      assignees: [
        { userId: "u1", estimateMinutes: null },
        { userId: "u2", estimateMinutes: null },
        { userId: "u3", estimateMinutes: null },
      ],
    });
    expect(taskShare(t, "u1")).toBe(200);
    expect(taskShare(t, "u4")).toBe(0); // not assigned
  });

  it("mixed rows: the assignee estimate stands alone, unset rows split the task estimate", () => {
    const t = task({
      estimateMinutes: 400,
      assignees: [
        { userId: "u1", estimateMinutes: 100 },
        { userId: "u2", estimateMinutes: null },
      ],
    });
    expect(taskShare(t, "u1")).toBe(100);
    expect(taskShare(t, "u2")).toBe(200); // 400 / 2 assignees
  });

  it("no estimate anywhere → 0 (the task still shows, it just contributes no minutes)", () => {
    expect(taskShare(task(), "u1")).toBe(0);
  });
});

describe("computeCapacity — Berlin week bucketing", () => {
  it("a task due Monday 00:30 Berlin lands in that week even though UTC says Sunday", () => {
    // 2026-10-12T00:30 Berlin = 2026-10-11T22:30 UTC — a UTC-day bucketer
    // would file it under W41; Berlin puts it in W42.
    const [row] = run([task({ dueAt: berlinLocalToUtc("2026-10-12T00:30"), estimateMinutes: 60 })]);
    expect(row!.weeks[0]!.demand).toBe(0);
    expect(row!.weeks[1]!.demand).toBe(60);
  });

  it("a task due Sunday 23:30 Berlin still belongs to the ending week", () => {
    // 2026-10-11T23:30 Berlin is already Monday in UTC.
    const [row] = run([task({ dueAt: berlinLocalToUtc("2026-10-11T23:30"), estimateMinutes: 90 })]);
    expect(row!.weeks[0]!.demand).toBe(90);
    expect(row!.weeks[1]!.demand).toBe(0);
  });

  it("the 25 h DST Sunday (2026-10-25) buckets the whole Berlin day into W43", () => {
    // 2026-10-25 is the Sunday of ISO week 43 (Mon Oct 19 … Sun Oct 25).
    const weeks = [0, 1].map((i) => ({
      isoWeek: `2026-W${43 + i}`,
      startDay: isoWeekRange("2026-W43").startDay + i * 7,
    }));
    const [row] = computeCapacity({
      users: [user()],
      tasks: [task({ dueAt: berlinLocalToUtc("2026-10-25T23:30"), estimateMinutes: 30 })],
      weeks,
      loggedCurrentWeek: NO_LOGGED,
    });
    expect(row!.weeks[0]!.demand).toBe(30); // Sun 23:30 still inside W43
    expect(row!.weeks[1]!.demand).toBe(0);
  });
});

describe("computeCapacity — capacity flags", () => {
  it("demand over the weekly capacity is flagged, equal or under is not", () => {
    const [row] = run([
      task({ dueAt: berlinLocalToUtc("2026-10-06T12:00"), estimateMinutes: 3000 }),
      task({ id: "t2", dueAt: berlinLocalToUtc("2026-10-13T12:00"), estimateMinutes: 2400 }),
    ]);
    expect(row!.weeks[0]).toMatchObject({ demand: 3000, over: true });
    expect(row!.weeks[1]).toMatchObject({ demand: 2400, over: false });
  });

  it("a user without capacity shows demand only — never a fake over flag", () => {
    const [row] = run(
      [task({ dueAt: berlinLocalToUtc("2026-10-06T12:00"), estimateMinutes: 99999 })],
      [user({ weeklyCapacityMinutes: null })],
    );
    expect(row!.capacityMinutes).toBeNull();
    expect(row!.weeks[0]!.demand).toBe(99999);
    expect(row!.weeks[0]!.over).toBe(false);
  });

  it("logged minutes land only in the current week's cell", () => {
    const logged = new Map([["u1", 345]]);
    const [row] = computeCapacity({
      users: [user()],
      tasks: [],
      weeks: WEEKS,
      loggedCurrentWeek: logged,
    });
    expect(row!.weeks[0]!.logged).toBe(345);
    expect(row!.weeks[1]!.logged).toBeUndefined();
  });
});

describe("computeCapacity — status and undated tasks", () => {
  it("DONE and CANCELLED tasks contribute nothing", () => {
    const [row] = run([
      task({ status: "DONE", dueAt: berlinLocalToUtc("2026-10-06T12:00"), estimateMinutes: 500 }),
      task({
        id: "t2",
        status: "CANCELLED",
        dueAt: berlinLocalToUtc("2026-10-06T12:00"),
        estimateMinutes: 500,
      }),
    ]);
    expect(row!.weeks[0]!.demand).toBe(0);
    expect(row!.noDue).toBe(0);
  });

  it("open tasks with no due date are counted in the ohne-Termin bucket", () => {
    const [row] = run([
      task({ estimateMinutes: 240 }),
      task({ id: "t2", estimateMinutes: 120 }),
      task({ id: "t3", estimateMinutes: 60, dueAt: berlinLocalToUtc("2026-10-06T12:00") }),
    ]);
    expect(row!.noDue).toBe(360);
    expect(row!.noDueCount).toBe(2);
    expect(row!.weeks[0]!.demand).toBe(60);
  });
});
