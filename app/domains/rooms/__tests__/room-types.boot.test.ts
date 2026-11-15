import { expect, it, vi } from "vitest";
import { reconcileRoomTypes } from "../room-types.library.server";
import { register } from "../room-types.boot.server";

vi.mock("../room-types.library.server", () => ({ reconcileRoomTypes: vi.fn() }));

it("keeps the application starting when room type reconciliation fails", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(reconcileRoomTypes).mockRejectedValueOnce(new Error("Synthetic startup failure"));
  try {
    await expect(register()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
  }
});
