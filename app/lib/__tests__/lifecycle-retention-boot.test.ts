import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "~/server/boot";

const { sessions, verifications, outbox, notifications } = vi.hoisted(() => ({
  sessions: vi.fn(),
  verifications: vi.fn(),
  outbox: vi.fn(),
  notifications: vi.fn(),
}));
vi.mock("~/domains/auth/auth.retention.server", () => ({
  pruneExpiredSessions: sessions,
  pruneExpiredVerifications: verifications,
}));
vi.mock("~/domains/notifications/notifications.mutations.server", () => ({
  pruneReadNotifications: notifications,
}));
vi.mock("~/lib/calendar/retention.server", () => ({
  pruneCompletedCalendarOutbox: outbox,
}));

import { register } from "~/lib/lifecycle-retention.boot.server";

const DAY = 86_400_000;
const app = {} as Express;
let ctx: BootContext;
let shutdown: () => Promise<void> | void;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
  sessions.mockResolvedValue(0);
  verifications.mockResolvedValue(0);
  notifications.mockResolvedValue(0);
  outbox.mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  ctx = {
    env: "production",
    server: {} as BootContext["server"],
    onShutdown: (hook) => {
      shutdown = hook;
    },
  };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("lifecycle retention boot", () => {
  it("runs immediately and daily with fresh exact cutoffs and independent category deletes", async () => {
    const boot = Date.now();
    await register(app, ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(sessions).toHaveBeenCalledExactlyOnceWith(new Date(boot));
    expect(verifications).toHaveBeenCalledExactlyOnceWith(new Date(boot));
    expect(notifications).toHaveBeenCalledExactlyOnceWith(new Date(boot - 90 * DAY));
    expect(outbox).toHaveBeenCalledExactlyOnceWith(new Date(boot - 30 * DAY));
    await vi.advanceTimersByTimeAsync(DAY);
    expect(sessions).toHaveBeenLastCalledWith(new Date(boot + DAY));
    expect(outbox).toHaveBeenCalledTimes(2);
    expect(console.log).not.toHaveBeenCalled();
  });

  it.each(["sessions", "verifications", "outbox", "notifications"] as const)(
    "recovers after a %s failure and still attempts the other categories",
    async (category) => {
      const mocks = { sessions, verifications, outbox, notifications };
      mocks[category].mockRejectedValueOnce(new Error("synthetic private details"));
      await register(app, ctx);
      await vi.advanceTimersByTimeAsync(0);
      for (const mock of Object.values(mocks)) expect(mock).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        `[lifecycle-retention] ${category} cleanup failed`,
      );
      await vi.advanceTimersByTimeAsync(DAY);
      for (const mock of Object.values(mocks)) expect(mock).toHaveBeenCalledTimes(2);
      expect(console.error).toHaveBeenCalledTimes(1);
    },
  );

  it("coalesces overlapping ticks and resumes after the current pass finishes", async () => {
    let finish!: (value: number) => void;
    sessions.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await register(app, ctx);
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(verifications).not.toHaveBeenCalled();
    finish(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(console.log).toHaveBeenCalledWith("[lifecycle-retention] pruned 2 sessions");
    await vi.advanceTimersByTimeAsync(DAY);
    expect(sessions).toHaveBeenCalledTimes(2);
    expect(verifications).toHaveBeenCalledTimes(2);
  });

  it("unrefs one interval and clears it idempotently on shutdown while allowing an in-flight pass to finish", async () => {
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
    let finish!: (value: number) => void;
    sessions.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await register(app, ctx);
    expect(interval).toHaveBeenCalledExactlyOnceWith(expect.any(Function), DAY);
    expect(unref).toHaveBeenCalledTimes(1);
    await shutdown();
    await shutdown();
    expect(vi.getTimerCount()).toBe(0);
    finish(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(notifications).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3 * DAY);
    await (interval.mock.calls[0]![0] as () => Promise<void>)();
    expect(sessions).toHaveBeenCalledTimes(1);
  });
});
