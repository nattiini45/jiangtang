import { describe, expect, it } from "vitest";
import { groupActivity, GROUP_WINDOW_MS, type GroupableActivity } from "../group-activity";

/**
 * `groupActivity`: consecutive same-actor/same-entity/same-action rows
 * within 15 minutes collapse into the newest row with a `count`.
 */

const T0 = new Date("2026-10-08T10:00:00Z").getTime();
const at = (min: number) => new Date(T0 + min * 60_000);

const row = (id: string, over: Partial<GroupableActivity> = {}): GroupableActivity => ({
  id,
  action: "NoteUpdated",
  entityType: "note",
  entityId: "n1",
  occurredAt: at(0),
  actorId: "u1",
  ...over,
});

describe("groupActivity", () => {
  it("collapses a consecutive same-actor/same-entity/same-action run", () => {
    const rows = [
      row("a", { occurredAt: at(10) }),
      row("b", { occurredAt: at(6) }),
      row("c", { occurredAt: at(0) }),
    ];
    const out = groupActivity(rows);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a");
    expect(out[0].count).toBe(3);
  });

  it("splits a run when the gap exceeds the window", () => {
    const rows = [row("a", { occurredAt: at(30) }), row("b", { occurredAt: at(0) })]; // 30 min apart
    const out = groupActivity(rows);
    expect(out.map((g) => g.count)).toEqual([1, 1]);
  });

  it("chains rows when each is within the window of the previous", () => {
    // 12 + 12 = 24 min total span, but each hop is under 15 — one group.
    const rows = [
      row("a", { occurredAt: at(24) }),
      row("b", { occurredAt: at(12) }),
      row("c", { occurredAt: at(0) }),
    ];
    expect(groupActivity(rows).map((g) => g.count)).toEqual([3]);
  });

  it("does not group across a different action, entity or actor", () => {
    const rows = [
      row("a"),
      row("b", { action: "NotePinned" }),
      row("c", { entityId: "n2" }),
      row("d", { actorId: "u2" }),
      row("e", { entityType: "task" }),
    ];
    expect(groupActivity(rows).map((g) => g.count)).toEqual([1, 1, 1, 1, 1]);
  });

  it("does not group rows separated by another entity's row, even inside the window", () => {
    const rows = [row("a"), row("x", { entityId: "n2" }), row("b")];
    const out = groupActivity(rows);
    expect(out.map((g) => [g.id, g.count])).toEqual([
      ["a", 1],
      ["x", 1],
      ["b", 1],
    ]);
  });

  it("accepts ISO-string occurredAt (post-serialization) identically", () => {
    const rows = [
      row("a", { occurredAt: at(5).toISOString() }),
      row("b", { occurredAt: at(0).toISOString() }),
    ];
    expect(groupActivity(rows).map((g) => g.count)).toEqual([2]);
  });

  it("15 minutes is exactly the boundary", () => {
    const rows = [
      row("a", { occurredAt: new Date(T0 + GROUP_WINDOW_MS) }),
      row("b", { occurredAt: new Date(T0) }),
    ];
    expect(groupActivity(rows).map((g) => g.count)).toEqual([2]);
  });
});
