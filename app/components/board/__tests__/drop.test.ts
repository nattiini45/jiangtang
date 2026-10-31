import { describe, expect, it } from "vitest";
import { computeDrop, finalLaneOrder } from "../drop";

/**
 * The drop contract. Every scenario walks both halves of the pure
 * API exactly as `onDragEnd` does: `finalLaneOrder` reproduces the visual
 * order the user saw, `computeDrop` derives the `moveTask` neighbours or vetoes
 * a no-op.
 */
describe("finalLaneOrder", () => {
  it("moves a card down by one: it lands in the hovered card's slot (after it)", () => {
    // [d, x, y], d dragged down over y → d takes y's index
    expect(finalLaneOrder(["d", "x", "y"], "d", "y", false)).toEqual(["x", "y", "d"]);
  });

  it("moves a card up: it lands before the hovered card", () => {
    expect(finalLaneOrder(["x", "y", "d"], "d", "x", false)).toEqual(["d", "x", "y"]);
  });

  it("appends when the drop target is the lane itself", () => {
    expect(finalLaneOrder(["d", "x"], "d", "L", true)).toEqual(["x", "d"]);
    // card preview-moved cross-lane, hovering the column's empty space
    expect(finalLaneOrder(["x", "y", "d"], "d", "L", true)).toEqual(["x", "y", "d"]);
  });

  it("reorders a preview-moved card onto the hovered card's slot", () => {
    // onDragOver inserted d before y; the drop settles d into y's slot
    expect(finalLaneOrder(["x", "d", "y"], "d", "y", false)).toEqual(["x", "y", "d"]);
  });

  it("inserts a card that never produced an onDragOver preview", () => {
    expect(finalLaneOrder(["x", "y"], "d", "y", false)).toEqual(["x", "d", "y"]);
    expect(finalLaneOrder(["x", "y"], "d", "L", true)).toEqual(["x", "y", "d"]);
  });

  it("appends when the hovered id is not a task in this lane (a ticket card)", () => {
    expect(finalLaneOrder(["x", "y"], "d", "ticket:tkt_1", false)).toEqual(["x", "y", "d"]);
  });
});

describe("computeDrop", () => {
  const origin = { lane: "BACKLOG" as const, ids: ["a", "b", "c"] };

  it("submits a cross-lane append to an empty lane (the silent-drop bug)", () => {
    // 'a' dragged onto empty In Arbeit space — onDragOver already moved it
    expect(computeDrop(origin, ["a"], "IN_PROGRESS", "a")).toEqual({ lane: "IN_PROGRESS" });
  });

  it("submits a cross-lane append to a non-empty lane", () => {
    expect(computeDrop(origin, ["x", "y", "a"], "IN_PROGRESS", "a")).toEqual({
      lane: "IN_PROGRESS",
      afterId: "y",
    });
  });

  it("submits a cross-lane insert between two cards", () => {
    expect(computeDrop(origin, ["x", "a", "y"], "IN_PROGRESS", "a")).toEqual({
      lane: "IN_PROGRESS",
      afterId: "x",
      beforeId: "y",
    });
  });

  it("submits a same-lane move down by one", () => {
    expect(computeDrop(origin, ["b", "a", "c"], "BACKLOG", "a")).toEqual({
      lane: "BACKLOG",
      afterId: "b",
      beforeId: "c",
    });
  });

  it("submits a same-lane move down by two", () => {
    expect(computeDrop(origin, ["b", "c", "a"], "BACKLOG", "a")).toEqual({
      lane: "BACKLOG",
      afterId: "c",
    });
  });

  it("submits a same-lane move up", () => {
    expect(computeDrop(origin, ["a", "c", "b"], "BACKLOG", "c")).toEqual({
      lane: "BACKLOG",
      afterId: "a",
      beforeId: "b",
    });
    // to the top
    expect(computeDrop(origin, ["b", "a", "c"], "BACKLOG", "b")).toEqual({
      lane: "BACKLOG",
      beforeId: "a",
    });
  });

  it("returns null when the card lands back between its origin neighbours", () => {
    expect(computeDrop(origin, ["a", "b", "c"], "BACKLOG", "a")).toBeNull();
    expect(computeDrop(origin, ["a", "b", "c"], "BACKLOG", "c")).toBeNull();
    // dragged out and back into the same lane at the same slot
    expect(computeDrop(origin, ["a", "b", "c"], "BACKLOG", "b")).toBeNull();
  });
});
