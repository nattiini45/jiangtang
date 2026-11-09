import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "~/server/boot";

const { getWarrantyWindowDays, listExpiringWarranties, notifyWarrantyExpiring } = vi.hoisted(
  () => ({
    getWarrantyWindowDays: vi.fn(),
    listExpiringWarranties: vi.fn(),
    notifyWarrantyExpiring: vi.fn(),
  }),
);

vi.mock("~/domains/inventory/inventory.stock.warranty.server", () => ({
  getWarrantyWindowDays,
  listExpiringWarranties,
}));
vi.mock("~/domains/notifications/notifications.mutations.server", () => ({
  notifyWarrantyExpiring,
}));

import { register } from "~/lib/warranty.boot.server";

const DAY_MS = 24 * 60 * 60 * 1000;
const app = {} as Express;
const expiring = [
  { id: "warranty-fixture", name: "Synthetic item", warrantyExpiresAt: new Date("2026-11-10") },
];
let onShutdown: ReturnType<typeof vi.fn<BootContext["onShutdown"]>>;
let ctx: BootContext;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  getWarrantyWindowDays.mockReturnValue(30);
  listExpiringWarranties.mockResolvedValue([]);
  notifyWarrantyExpiring.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  onShutdown = vi.fn<BootContext["onShutdown"]>();
  ctx = { env: "production", server: {} as BootContext["server"], onShutdown };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("warranty boot baseline", () => {
  it("catches up immediately, then runs daily without notifying or logging empty sweeps", async () => {
    await register(app, ctx);

    expect(listExpiringWarranties).toHaveBeenCalledExactlyOnceWith({ withinDays: 30 });
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(listExpiringWarranties).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(listExpiringWarranties).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(listExpiringWarranties).toHaveBeenCalledTimes(3);
    expect(getWarrantyWindowDays).toHaveBeenCalledTimes(3);
    expect(notifyWarrantyExpiring).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs and notifies for a nonempty sweep", async () => {
    listExpiringWarranties.mockResolvedValueOnce(expiring);

    await register(app, ctx);

    expect(console.log).toHaveBeenCalledExactlyOnceWith("[warranty] 1 item(s) expire within 30d");
    expect(notifyWarrantyExpiring).toHaveBeenCalledExactlyOnceWith(expiring);
  });

  it("logs boot and periodic query failures without stopping later ticks", async () => {
    listExpiringWarranties
      .mockRejectedValueOnce(new Error("boot failure"))
      .mockRejectedValueOnce(new Error("daily failure"));

    await expect(register(app, ctx)).resolves.toBeUndefined();

    expect(console.error).toHaveBeenNthCalledWith(1, "[warranty] sweep failed:", "boot failure");
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(console.error).toHaveBeenNthCalledWith(2, "[warranty] sweep failed:", "daily failure");
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(listExpiringWarranties).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("logs notification failures without stopping later ticks", async () => {
    listExpiringWarranties.mockResolvedValue(expiring);
    notifyWarrantyExpiring.mockRejectedValueOnce(new Error("notification failure"));

    await register(app, ctx);
    await vi.advanceTimersByTimeAsync(0);

    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "[warranty] sweep failed:",
      "notification failure",
    );
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(notifyWarrantyExpiring).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("unrefs its single daily interval", async () => {
    const schedule = globalThis.setInterval;
    const unref = vi.fn();
    const interval = vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) => {
      const handle = schedule(callback, delay);
      vi.spyOn(handle, "unref").mockImplementation(() => {
        unref();
        return handle;
      });
      return handle;
    });

    await register(app, ctx);

    expect(interval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), DAY_MS);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe("warranty boot shutdown", () => {
  it("registers one cleanup that safely clears the interval more than once", async () => {
    await register(app, ctx);

    expect(onShutdown).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    const [shutdown] = onShutdown.mock.calls[0]!;
    expect(shutdown()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(shutdown()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts no further ticks after shutdown", async () => {
    await register(app, ctx);
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(listExpiringWarranties).toHaveBeenCalledTimes(2);

    for (const [shutdown] of onShutdown.mock.calls) await shutdown();
    await vi.advanceTimersByTimeAsync(3 * DAY_MS);

    expect(listExpiringWarranties).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets an in-flight catch-up finish without awaiting it or starting another tick", async () => {
    let finish!: (items: typeof expiring) => void;
    listExpiringWarranties.mockReturnValueOnce(
      new Promise<typeof expiring>((resolve) => {
        finish = resolve;
      }),
    );

    await register(app, ctx);
    expect(listExpiringWarranties).toHaveBeenCalledTimes(1);
    expect(notifyWarrantyExpiring).not.toHaveBeenCalled();

    for (const [shutdown] of onShutdown.mock.calls) expect(shutdown()).toBeUndefined();
    finish(expiring);
    await vi.advanceTimersByTimeAsync(0);

    expect(notifyWarrantyExpiring).toHaveBeenCalledExactlyOnceWith(expiring);
    await vi.advanceTimersByTimeAsync(3 * DAY_MS);
    expect(listExpiringWarranties).toHaveBeenCalledTimes(1);
    expect(notifyWarrantyExpiring).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
