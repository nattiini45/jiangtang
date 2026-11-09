import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "~/server/boot";

const { pruneActivityLog } = vi.hoisted(() => ({ pruneActivityLog: vi.fn() }));

vi.mock("~/domains/auth/gdpr.server", () => ({ pruneActivityLog }));

import { register } from "~/lib/retention.boot.server";

const DAY_MS = 24 * 60 * 60 * 1000;
const app = {} as Express;
let onShutdown: ReturnType<typeof vi.fn<BootContext["onShutdown"]>>;
let ctx: BootContext;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
  vi.stubEnv("ACTIVITY_RETENTION_DAYS", "30");
  pruneActivityLog.mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  onShutdown = vi.fn<BootContext["onShutdown"]>();
  ctx = { env: "production", server: {} as BootContext["server"], onShutdown };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("retention boot baseline", () => {
  it("catches up immediately, then runs daily with a fresh cutoff and stays quiet for zero rows", async () => {
    const bootTime = Date.now();

    await register(app, ctx);

    expect(pruneActivityLog).toHaveBeenCalledExactlyOnceWith(new Date(bootTime - 30 * DAY_MS));
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(pruneActivityLog).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pruneActivityLog).toHaveBeenNthCalledWith(2, new Date(bootTime - 29 * DAY_MS));
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(pruneActivityLog).toHaveBeenCalledTimes(3);
    expect(pruneActivityLog).toHaveBeenNthCalledWith(3, new Date(bootTime - 28 * DAY_MS));
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("logs a positive result", async () => {
    pruneActivityLog.mockResolvedValueOnce(2);

    await register(app, ctx);

    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      "[retention] pruned 2 activity rows older than 30d",
    );
  });

  it("logs boot and periodic failures without stopping later ticks", async () => {
    pruneActivityLog
      .mockRejectedValueOnce(new Error("boot failure"))
      .mockRejectedValueOnce(new Error("daily failure"));

    await expect(register(app, ctx)).resolves.toBeUndefined();

    expect(console.error).toHaveBeenNthCalledWith(1, "[retention] prune failed:", "boot failure");
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(console.error).toHaveBeenNthCalledWith(2, "[retention] prune failed:", "daily failure");
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(pruneActivityLog).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledTimes(2);
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

describe("retention boot shutdown", () => {
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
    expect(pruneActivityLog).toHaveBeenCalledTimes(2);

    for (const [shutdown] of onShutdown.mock.calls) await shutdown();
    await vi.advanceTimersByTimeAsync(3 * DAY_MS);

    expect(pruneActivityLog).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets an in-flight catch-up finish without awaiting it or starting another tick", async () => {
    let finish!: (deleted: number) => void;
    pruneActivityLog.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );

    await register(app, ctx);
    expect(pruneActivityLog).toHaveBeenCalledTimes(1);
    expect(console.log).not.toHaveBeenCalled();

    for (const [shutdown] of onShutdown.mock.calls) expect(shutdown()).toBeUndefined();
    finish(1);
    await vi.advanceTimersByTimeAsync(0);

    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      "[retention] pruned 1 activity rows older than 30d",
    );
    await vi.advanceTimersByTimeAsync(3 * DAY_MS);
    expect(pruneActivityLog).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
