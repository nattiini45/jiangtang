import { describe, expect, it, vi } from "vitest";
import { getRetentionDays, retentionCutoff } from "~/lib/retention.boot.server";

/**
 * The retention cutoff must be recomputed on every tick, not frozen at boot.
 * `register()` itself wires a `setInterval` around `pruneActivityLog` (DB-backed;
 * exercised against a real database in gdpr.test.ts), so these tests target the
 * extracted pure pieces directly — no DB needed, and they'd catch a regression
 * back to a boot-time-memoized cutoff.
 */
describe("retention cutoff", () => {
  it("advances as time passes between calls (not frozen at first computation)", () => {
    const base = new Date("2026-01-01T00:00:00Z").getTime();
    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValue(base);
    const first = retentionCutoff(2555);

    nowSpy.mockReturnValue(base + 24 * 60 * 60 * 1000); // +1 day
    const second = retentionCutoff(2555);

    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(second.getTime() - first.getTime()).toBe(24 * 60 * 60 * 1000);

    nowSpy.mockRestore();
  });

  it("computes cutoff as now - retentionDays", () => {
    const now = new Date("2026-07-03T12:00:00Z").getTime();
    vi.spyOn(Date, "now").mockReturnValue(now);

    const cutoff = retentionCutoff(10);
    expect(cutoff.getTime()).toBe(now - 10 * 24 * 60 * 60 * 1000);

    vi.restoreAllMocks();
  });

  it("defaults to ~7 years when ACTIVITY_RETENTION_DAYS is unset", () => {
    const prev = process.env.ACTIVITY_RETENTION_DAYS;
    delete process.env.ACTIVITY_RETENTION_DAYS;
    try {
      expect(getRetentionDays()).toBe(2555);
    } finally {
      if (prev !== undefined) process.env.ACTIVITY_RETENTION_DAYS = prev;
    }
  });

  it("reads ACTIVITY_RETENTION_DAYS when set", () => {
    const prev = process.env.ACTIVITY_RETENTION_DAYS;
    process.env.ACTIVITY_RETENTION_DAYS = "30";
    try {
      expect(getRetentionDays()).toBe(30);
    } finally {
      if (prev === undefined) delete process.env.ACTIVITY_RETENTION_DAYS;
      else process.env.ACTIVITY_RETENTION_DAYS = prev;
    }
  });

  it("falls back to the default for a malformed or non-positive value (no NaN cutoff)", () => {
    const prev = process.env.ACTIVITY_RETENTION_DAYS;
    try {
      for (const bad of ["thirty", "", "0", "-5", "NaN"]) {
        process.env.ACTIVITY_RETENTION_DAYS = bad;
        expect(getRetentionDays()).toBe(2555);
        // And the derived cutoff is a valid Date, not Invalid Date.
        expect(Number.isNaN(retentionCutoff(getRetentionDays()).getTime())).toBe(false);
      }
    } finally {
      if (prev === undefined) delete process.env.ACTIVITY_RETENTION_DAYS;
      else process.env.ACTIVITY_RETENTION_DAYS = prev;
    }
  });
});
