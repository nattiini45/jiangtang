import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatDateWith,
  formatNumber,
  formatRange,
  formatTime,
} from "~/i18n/format";

// 2026-10-30T12:00:00Z is 13:00 in Berlin (CEST ended 2026-10-25), 2026-07-01T12:00:00Z is 14:00 (CEST).
const WINTER = new Date("2026-10-30T12:00:00Z");
const SUMMER = new Date("2026-07-01T12:00:00Z");

describe("date formatting", () => {
  it("renders German day-first dates and English dates for the same day", () => {
    expect(formatDate("de", WINTER)).toBe("30.10.2026");
    expect(formatDate("en", WINTER)).toBe("30 Oct 2026");
  });

  it("shows the same Berlin wall clock in both languages", () => {
    expect(formatTime("de", WINTER)).toBe("13:00");
    expect(formatTime("en", WINTER)).toBe("13:00");
    expect(formatTime("de", SUMMER)).toBe("14:00");
    expect(formatTime("en", SUMMER)).toBe("14:00");
    expect(formatDateTime("de", SUMMER)).toContain("14:00");
    expect(formatDateTime("en", SUMMER)).toContain("14:00");
  });

  it("uses the Berlin calendar day, not the UTC one, near midnight", () => {
    const lateUtc = new Date("2026-06-30T22:30:00Z");
    expect(formatDate("de", lateUtc)).toBe("01.07.2026");
    expect(formatDate("en", lateUtc)).toBe("1 Jul 2026");
  });

  it("accepts ISO strings and timestamps like Dates", () => {
    expect(formatDateTime("de", "2026-10-30T12:00:00Z")).toBe(formatDateTime("de", WINTER));
    expect(formatDateTime("en", WINTER.getTime())).toBe(formatDateTime("en", WINTER));
  });

  it("formats a range as start – end", () => {
    const end = new Date("2026-10-30T14:30:00Z");
    expect(formatRange("de", WINTER, end)).toBe("30.10.2026, 13:00 – 30.10.2026, 15:30");
    expect(formatRange("en", WINTER, end)).toMatch(/13:00 – 30 Oct 2026, 15:30$/);
  });

  it("keeps Berlin as the time zone for custom option sets", () => {
    expect(formatDateWith("de", WINTER, { month: "long", year: "numeric" })).toBe("Oktober 2026");
    expect(formatDateWith("en", WINTER, { month: "long", year: "numeric" })).toBe("October 2026");
  });
});

describe("number formatting", () => {
  it("uses the locale's separators", () => {
    expect(formatNumber("de", 1234.5, { maximumFractionDigits: 1 })).toBe("1.234,5");
    expect(formatNumber("en", 1234.5, { maximumFractionDigits: 1 })).toBe("1,234.5");
    expect(formatNumber("de", 1.5, { maximumFractionDigits: 1 })).toBe("1,5");
    expect(formatNumber("en", 1.5, { maximumFractionDigits: 1 })).toBe("1.5");
  });
});
