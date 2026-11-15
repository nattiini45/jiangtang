import { describe, expect, it } from "vitest";
import { berlinLocalToUtc, utcToBerlinLocal } from "../time.server";

describe("Berlin wall-clock precision", () => {
  it.each([
    ["2025-01-03T10:00:12.001Z", "2025-01-03T11:00:12.001"],
    ["2025-01-03T10:00:12.100Z", "2025-01-03T11:00:12.100"],
    ["2025-07-03T10:00:12.123Z", "2025-07-03T12:00:12.123"],
    ["2025-07-03T10:00:12.999Z", "2025-07-03T12:00:12.999"],
  ])("preserves the instant %s through a precise local form", (instant, local) => {
    expect(utcToBerlinLocal(new Date(instant), "millisecond")).toBe(local);
    expect(berlinLocalToUtc(local).toISOString()).toBe(instant);
  });

  it("keeps existing minute-only forms unchanged", () => {
    expect(utcToBerlinLocal(new Date("2025-01-03T10:00:12.123Z"))).toBe("2025-01-03T11:00");
    expect(berlinLocalToUtc("2025-01-03T11:00").toISOString()).toBe("2025-01-03T10:00:00.000Z");
  });
});
