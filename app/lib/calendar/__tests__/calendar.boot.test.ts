import { afterEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import { createServer } from "node:http";
import { NoopPublisher } from "~/lib/calendar/publisher.server";

const { initialize, drain, factory } = vi.hoisted(() => ({
  initialize: vi.fn(),
  drain: vi.fn(),
  factory: vi.fn(),
}));
vi.mock("~/lib/calendar/initial-publication.server", () => ({
  initializeCalendarPublication: initialize,
}));
vi.mock("~/lib/calendar/outbox.server", () => ({ drainOnce: drain }));
vi.mock("~/lib/calendar/publisher-factory.server", () => ({ getPublisher: factory }));
import { register } from "~/lib/calendar/calendar.boot.server";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("calendar boot initialization gate", () => {
  it("stays idle without configuration", async () => {
    factory.mockReturnValue(new NoopPublisher());
    const interval = vi.spyOn(globalThis, "setInterval");
    await register({} as Express, {
      env: "development",
      server: createServer(),
      onShutdown: vi.fn(),
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });

  it("never drains until initialization commits, recovers after failure, and clears its timer", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = { upsert: vi.fn(), remove: vi.fn() };
    factory.mockReturnValue(fake);
    initialize
      .mockRejectedValueOnce(new Error("synthetic database failure"))
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    drain.mockResolvedValue({ sent: 0, failed: 0, skipped: 0, superseded: 0 });
    let shutdown!: () => void | Promise<void>;
    const interval = vi.spyOn(globalThis, "setInterval");
    await expect(
      register({} as Express, {
        env: "development",
        server: createServer(),
        onShutdown: (fn) => {
          shutdown = fn;
        },
      }),
    ).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(drain).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(drain).toHaveBeenCalledExactlyOnceWith(fake);
    expect(interval.mock.results[0].value.hasRef()).toBe(false);
    await shutdown();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
