import { describe, expect, it } from "vitest";
import {
  buildGantt,
  burndownRange,
  computeBurndown,
  idealRemaining,
  type GanttTask,
} from "../gantt";
import { berlinDayIndex, dayIndexToDateKey, isoWeekRange } from "~/lib/berlin-days";

/** Berlin local datetime → instant (test-only helper, same two-pass idea). */
const B = (local: string) => {
  const naive = new Date(`${local}:00Z`);
  const off = (ms: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(ms));
    const m: Record<string, number> = {};
    for (const p of parts) if (p.type !== "literal") m[p.type] = Number(p.value);
    return Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second) - ms;
  };
  return new Date(naive.getTime() - off(naive.getTime() - off(naive.getTime())));
};

const t = (partial: Partial<GanttTask> & { id: string }): GanttTask => ({
  title: partial.id,
  status: "TODO",
  startAt: null,
  dueAt: null,
  parentTaskId: null,
  blockerIds: [],
  ...partial,
});

const TODAY = B("2026-10-08T12:00");

describe("buildGantt", () => {
  it("lays out a bar from startAt day to dueAt day (Berlin)", () => {
    const layout = buildGantt({
      today: TODAY,
      tasks: [t({ id: "a", startAt: B("2026-10-05T09:00"), dueAt: B("2026-10-09T18:00") })],
    });
    const row = layout.rows[0];
    expect(dayIndexToDateKey(row.bar!.from)).toBe("2026-10-05");
    expect(dayIndexToDateKey(row.bar!.to)).toBe("2026-10-09");
    expect(layout.unscheduled).toHaveLength(0);
  });

  it("renders a due-only task as a milestone and a start-only one as a one-day bar", () => {
    const layout = buildGantt({
      today: TODAY,
      tasks: [
        t({ id: "m", dueAt: B("2026-10-10T12:00") }),
        t({ id: "s", startAt: B("2026-10-07T08:00") }),
      ],
    });
    expect(layout.rows.find((r) => r.task.id === "m")!.milestone).toBe(
      berlinDayIndex(B("2026-10-10T12:00")),
    );
    const s = layout.rows.find((r) => r.task.id === "s")!;
    expect(s.bar).toEqual({
      from: berlinDayIndex(B("2026-10-07T08:00")),
      to: berlinDayIndex(B("2026-10-07T08:00")),
    });
  });

  it("sends tasks with neither date to the unscheduled list (with their subtree)", () => {
    const layout = buildGantt({
      today: TODAY,
      tasks: [
        t({ id: "root", startAt: B("2026-10-01T09:00"), dueAt: B("2026-10-30T18:00") }),
        t({ id: "child", parentTaskId: "root" }),
        t({ id: "grand", parentTaskId: "child" }),
      ],
    });
    // The grandchild is unscheduled too — both land in „Ohne Termin".
    expect(layout.unscheduled.map((x) => x.id)).toEqual(["child", "grand"]);
    expect(layout.rows.map((r) => r.task.id)).toEqual(["root"]);
  });

  it("indents subtasks under their parent in depth-first order", () => {
    const layout = buildGantt({
      today: TODAY,
      tasks: [
        t({ id: "p", dueAt: B("2026-10-20T18:00") }),
        t({ id: "c1", parentTaskId: "p", dueAt: B("2026-10-12T18:00") }),
        t({ id: "c2", parentTaskId: "p", dueAt: B("2026-10-15T18:00") }),
        t({ id: "q", dueAt: B("2026-10-18T18:00") }),
      ],
    });
    expect(layout.rows.map((r) => [r.task.id, r.depth])).toEqual([
      ["p", 0],
      ["c1", 1],
      ["c2", 1],
      ["q", 0],
    ]);
  });

  it("marks overdue bars and mutes done ones", () => {
    const layout = buildGantt({
      today: TODAY,
      tasks: [
        t({ id: "late", dueAt: B("2026-10-06T18:00") }),
        t({ id: "done", status: "DONE", dueAt: B("2026-10-06T18:00") }),
      ],
    });
    expect(layout.rows.find((r) => r.task.id === "late")!.overdue).toBe(true);
    const done = layout.rows.find((r) => r.task.id === "done")!;
    expect(done.done).toBe(true);
    expect(done.overdue).toBe(false);
  });

  it("draws dependency arrows blocker end → blocked start", () => {
    const layout = buildGantt({
      today: TODAY,
      tasks: [
        t({ id: "blocker", startAt: B("2026-10-05T09:00"), dueAt: B("2026-10-07T18:00") }),
        t({
          id: "blocked",
          startAt: B("2026-10-08T09:00"),
          dueAt: B("2026-10-10T18:00"),
          blockerIds: ["blocker"],
        }),
      ],
    });
    expect(layout.arrows).toHaveLength(1);
    const a = layout.arrows[0];
    expect(a.fromRow).toBe(0);
    expect(a.toRow).toBe(1);
    expect(a.x0).toBe(berlinDayIndex(B("2026-10-07T18:00")) + 1); // blocker's end edge
    expect(a.x1).toBe(berlinDayIndex(B("2026-10-08T09:00"))); // blocked's start edge
  });

  it("skips arrows whose blocker is outside the project", () => {
    const layout = buildGantt({
      today: TODAY,
      tasks: [t({ id: "solo", dueAt: B("2026-10-10T18:00"), blockerIds: ["not-here"] })],
    });
    expect(layout.arrows).toHaveLength(0);
  });

  it("emits ISO week grid lines and a today marker inside the range", () => {
    const layout = buildGantt({
      today: TODAY,
      tasks: [t({ id: "a", startAt: B("2026-10-05T09:00"), dueAt: B("2026-10-20T18:00") })],
    });
    expect(layout.weeks.length).toBeGreaterThanOrEqual(3);
    expect(layout.weeks[0].label).toMatch(/^KW \d{2}$/);
    expect(layout.today).toBe(berlinDayIndex(TODAY));
    expect(layout.projectBand).toBeUndefined();
  });

  it("exposes the project's own span as a band", () => {
    const layout = buildGantt({
      today: TODAY,
      projectStartAt: B("2026-10-01T09:00"),
      projectDueAt: B("2026-10-30T18:00"),
      tasks: [t({ id: "a", dueAt: B("2026-10-10T18:00") })],
    });
    expect(layout.projectBand).toEqual({
      from: berlinDayIndex(B("2026-10-01T09:00")),
      to: berlinDayIndex(B("2026-10-30T18:00")) + 1,
    });
    expect(layout.startDay).toBeLessThanOrEqual(berlinDayIndex(B("2026-10-01T09:00")));
  });
});

describe("computeBurndown", () => {
  const range = () => ({
    startDay: berlinDayIndex(B("2026-10-05T12:00")),
    endDay: berlinDayIndex(B("2026-10-09T12:00")),
  });

  it("reconstructs remaining estimate from status events", () => {
    const tasks = [
      { id: "a", estimateMinutes: 120, createdAt: B("2026-10-05T09:00") },
      { id: "b", estimateMinutes: 60, createdAt: B("2026-10-05T09:00") },
    ];
    const events = [
      { taskId: "a", action: "TaskCreated", occurredAt: B("2026-10-05T09:00"), to: "BACKLOG" },
      { taskId: "b", action: "TaskCreated", occurredAt: B("2026-10-05T09:00"), to: "BACKLOG" },
      { taskId: "a", action: "TaskStatusChanged", occurredAt: B("2026-10-07T15:00"), to: "DONE" },
    ];
    const points = computeBurndown(tasks, events, range());
    expect(points.find((p) => p.day === "2026-10-06")!.remaining).toBe(180);
    expect(points.find((p) => p.day === "2026-10-07")!.remaining).toBe(60); // a done that day
    expect(points.at(-1)!.remaining).toBe(60);
  });

  it("counts a done-then-reopened task again after reopening", () => {
    const tasks = [{ id: "a", estimateMinutes: 90, createdAt: B("2026-10-05T09:00") }];
    const events = [
      { taskId: "a", action: "TaskStatusChanged", occurredAt: B("2026-10-06T10:00"), to: "DONE" },
      { taskId: "a", action: "TaskStatusChanged", occurredAt: B("2026-10-08T10:00"), to: "TODO" },
    ];
    const points = computeBurndown(tasks, events, range());
    expect(points.find((p) => p.day === "2026-10-05")!.remaining).toBe(90);
    expect(points.find((p) => p.day === "2026-10-07")!.remaining).toBe(0);
    expect(points.find((p) => p.day === "2026-10-08")!.remaining).toBe(90);
  });

  it("adds a task created mid-way from its creation day on", () => {
    const tasks = [
      { id: "a", estimateMinutes: 100, createdAt: B("2026-10-05T09:00") },
      { id: "b", estimateMinutes: 50, createdAt: B("2026-10-07T11:00") },
    ];
    const events = [
      { taskId: "a", action: "TaskCreated", occurredAt: B("2026-10-05T09:00"), to: "BACKLOG" },
      { taskId: "b", action: "TaskCreated", occurredAt: B("2026-10-07T11:00"), to: "TODO" },
    ];
    const points = computeBurndown(tasks, events, range());
    expect(points.find((p) => p.day === "2026-10-06")!.remaining).toBe(100);
    expect(points.find((p) => p.day === "2026-10-07")!.remaining).toBe(150);
  });

  it("drops a cancelled task via TaskMoved's toStatus and a deleted one via TaskDeleted", () => {
    const tasks = [
      { id: "a", estimateMinutes: 40, createdAt: B("2026-10-05T09:00") },
      { id: "b", estimateMinutes: 40, createdAt: B("2026-10-05T09:00") },
    ];
    const events = [
      { taskId: "a", action: "TaskMoved", occurredAt: B("2026-10-06T09:00"), to: "CANCELLED" },
      { taskId: "b", action: "TaskDeleted", occurredAt: B("2026-10-07T09:00") },
    ];
    const points = computeBurndown(tasks, events, range());
    expect(points.find((p) => p.day === "2026-10-05")!.remaining).toBe(80);
    expect(points.find((p) => p.day === "2026-10-06")!.remaining).toBe(40);
    expect(points.find((p) => p.day === "2026-10-07")!.remaining).toBe(0);
  });

  it("ignores tasks without an estimate", () => {
    const tasks = [
      { id: "a", estimateMinutes: null, createdAt: B("2026-10-05T09:00") },
      { id: "b", estimateMinutes: 30, createdAt: B("2026-10-05T09:00") },
    ];
    const points = computeBurndown(tasks, [], range());
    expect(points[0].remaining).toBe(30);
  });

  it("does not double-count the 25-hour DST day", () => {
    // 2026-10-25 is 25 h in Berlin — the day appears exactly once.
    const tasks = [{ id: "a", estimateMinutes: 10, createdAt: B("2026-10-20T09:00") }];
    const points = computeBurndown(tasks, [], {
      startDay: berlinDayIndex(B("2026-10-24T12:00")),
      endDay: berlinDayIndex(B("2026-10-26T12:00")),
    });
    expect(points.map((p) => p.day)).toEqual(["2026-10-24", "2026-10-25", "2026-10-26"]);
    expect(points.every((p) => p.remaining === 10)).toBe(true);
  });
});

describe("burndownRange", () => {
  const bt = (createdAt: string) => ({
    id: createdAt,
    estimateMinutes: 60,
    createdAt: B(createdAt),
  });

  it("starts at the later of project start and first task creation", () => {
    // Project started in July but tasks were only created in October — the
    // flat zero prefix is cut and the range opens at first creation.
    const { startDay } = burndownRange({
      today: TODAY,
      projectStartAt: B("2026-07-20T09:00"),
      tasks: [bt("2026-10-03T10:00"), bt("2026-10-05T10:00")],
    });
    expect(dayIndexToDateKey(startDay)).toBe("2026-10-03");
  });

  it("still starts at the project start when a task predates it", () => {
    const { startDay } = burndownRange({
      today: TODAY,
      projectStartAt: B("2026-10-05T09:00"),
      tasks: [bt("2026-10-01T10:00")],
    });
    expect(dayIndexToDateKey(startDay)).toBe("2026-10-05");
  });

  it("falls back to first creation / today when sides are missing", () => {
    expect(
      dayIndexToDateKey(burndownRange({ today: TODAY, tasks: [bt("2026-10-03T10:00")] }).startDay),
    ).toBe("2026-10-03");
    expect(burndownRange({ today: TODAY, tasks: [] }).startDay).toBe(berlinDayIndex(TODAY));
  });

  it("ends at the later of today and dueAt, and reports dueDay for the ideal line", () => {
    const r = burndownRange({
      today: TODAY,
      projectDueAt: B("2026-10-20T18:00"),
      tasks: [bt("2026-10-03T10:00")],
    });
    expect(dayIndexToDateKey(r.endDay)).toBe("2026-10-20");
    expect(r.dueDay).toBe(berlinDayIndex(B("2026-10-20T18:00")));
    expect(burndownRange({ today: TODAY, tasks: [bt("2026-10-03T10:00")] }).dueDay).toBeNull();
  });
});

describe("idealRemaining", () => {
  it("walks linearly from start to zero at dueAt", () => {
    expect(idealRemaining(100, 10, 20, 10)).toBe(100);
    expect(idealRemaining(100, 10, 20, 15)).toBe(50);
    expect(idealRemaining(100, 10, 20, 20)).toBe(0);
    expect(idealRemaining(100, 10, 20, 25)).toBe(0);
    expect(idealRemaining(100, 10, null, 15)).toBeNull();
    expect(idealRemaining(100, 10, 10, 10)).toBeNull(); // degenerate range
  });
});

describe("isoWeekRange", () => {
  it("returns Monday..Sunday of the ISO week in Berlin days", () => {
    const { startDay, endDay } = isoWeekRange("2026-W41");
    expect(dayIndexToDateKey(startDay)).toBe("2026-10-05"); // Monday
    expect(dayIndexToDateKey(endDay)).toBe("2026-10-11"); // Sunday
  });
});
