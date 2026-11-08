import { describe, expect, it } from "vitest";
import { statusToken, taskPriorityClassName } from "~/lib/status";

describe("semantic task colors", () => {
  it.each([
    ["BACKLOG", "neutral"],
    ["TODO", "info"],
    ["IN_PROGRESS", "warning"],
    ["IN_REVIEW", "review"],
    ["BLOCKED", "fault"],
    ["DONE", "operational"],
    ["CANCELLED", "neutral"],
  ] as const)("maps %s to %s in both locales", (status, tone) => {
    for (const locale of ["de", "en"] as const) {
      const token = statusToken(locale, "task", status);
      expect(token.tone).toBe(tone);
      expect(token.className).toContain("text-foreground");
      expect(token.label).not.toBe(`status.task.${status}`);
    }
  });

  it.each([
    ["URGENT", "text-priority-urgent"],
    ["HIGH", "text-priority-high"],
    ["MEDIUM", "text-priority-medium"],
    ["LOW", "text-priority-low"],
    ["LOWEST", "text-priority-low"],
    [null, ""],
  ] as const)("maps priority %s without inventing a default", (priority, className) => {
    expect(taskPriorityClassName(priority)).toBe(className);
  });
});
