import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitChange } from "~/lib/realtime/emit.server";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), warn: vi.fn() }));
vi.mock("~/lib/db.server", () => ({ db: { $executeRaw: mocks.execute } }));
vi.mock("~/lib/observability/logger.server", () => ({ logger: { warn: mocks.warn } }));

beforeEach(() => vi.resetAllMocks());

describe("post-commit change notifications", () => {
  it("does not report a committed mutation as failed when NOTIFY is unavailable", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("Private database connection details"));
    await expect(
      emitChange({ entityType: "task", id: "synthetic-task", op: "created" }),
    ).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(
      { entityType: "task", id: "synthetic-task" },
      "Post-commit notification failed",
    );
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(
      "Private database connection details",
    );
  });

  it("keeps notifying other affected entities after one notification fails", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("Temporary failure")).mockResolvedValueOnce(1);
    await emitChange({ entityType: "attachment", id: "synthetic-image", op: "created" });
    await emitChange({ entityType: "room", id: "synthetic-room", op: "updated" });
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
});
