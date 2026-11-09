import { describe, expect, it, vi } from "vitest";
import { TaskStatus } from "~/generated/prisma/enums";
import { commandRejection, paletteTask, verbsFor } from "~/components/command/verbs";
import { taskAllowedActions } from "~/domains/tasks/tasks.transitions";

describe("task palette context", () => {
  it("uses actual task data, not just a route handle or URL parameter", () => {
    expect(paletteTask([{ handle: { palette: "task" } }])).toBeUndefined();
    expect(paletteTask([{ data: { task: { id: "synthetic", status: "TODO" } } }])).toBeUndefined();
    expect(
      paletteTask([
        { handle: { palette: "task" }, data: { task: { id: "synthetic", status: "BOGUS" } } },
      ]),
    ).toBeUndefined();
    expect(
      paletteTask([
        { handle: { palette: "task" }, data: { task: { id: "synthetic", status: "BLOCKED" } } },
      ]),
    ).toEqual({ id: "synthetic", status: "BLOCKED" });
  });
  for (const status of Object.values(TaskStatus)) {
    it(`${status}: offers only legal next statuses while keeping assign/edit verbs`, () => {
      const verbs = verbsFor({ admin: false, context: "task", task: { status }, locale: "en" });
      const statusVerbs = verbs.filter((verb) => verb.taskStatus);
      expect(statusVerbs.map((verb) => verb.taskStatus)).toEqual(
        taskAllowedActions(status).map((action) => action.target),
      );
      expect(verbs.some((verb) => verb.id === "task-assign-me")).toBe(true);
      expect(verbs.some((verb) => verb.id === "task-edit-title")).toBe(true);
      for (const verb of statusVerbs) {
        const submit = vi.fn();
        verb.run({ taskId: "synthetic", submit, navigate: vi.fn(), close: vi.fn(), query: "" });
        expect(submit).toHaveBeenCalledWith(
          { _action: "set-status", status: verb.taskStatus },
          "/tasks/synthetic",
        );
      }
    });
  }
  it("does not offer status verbs without loaded current state and surfaces server rejection messages", () => {
    expect(
      verbsFor({ admin: true, context: "task", locale: "en" }).some((verb) => verb.taskStatus),
    ).toBe(false);
    expect(
      commandRejection({
        formErrors: ["Synthetic stale status"],
        fieldErrors: { status: ["Other"] },
      }),
    ).toBe("Synthetic stale status");
    expect(commandRejection({ fieldErrors: { status: ["Synthetic status error"] } })).toBe(
      "Synthetic status error",
    );
    expect(commandRejection(undefined)).toBeUndefined();
    expect(commandRejection({ ok: true })).toBeUndefined();
  });
});
