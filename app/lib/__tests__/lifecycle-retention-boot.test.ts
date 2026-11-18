import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "~/server/boot";

const { sessions, verifications, outbox, notifications, mail } = vi.hoisted(() => ({
  sessions: vi.fn(),
  verifications: vi.fn(),
  outbox: vi.fn(),
  notifications: vi.fn(),
  mail: vi.fn(),
}));
vi.mock("~/domains/mail/mail.server", () => ({ pruneMailDeliveries: mail }));
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

import { register as registerJobs } from "~/lib/jobs.boot.server";
import { pruneLifecycleData, register } from "~/lib/lifecycle-retention.boot.server";

const DAY = 86_400_000;
const NOW = new Date("2026-11-09T12:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  sessions.mockResolvedValue(0);
  verifications.mockResolvedValue(0);
  notifications.mockResolvedValue(0);
  outbox.mockResolvedValue(0);
  mail.mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("lifecycle retention job", () => {
  it("recomputes exact cutoffs for each run and records the category totals", async () => {
    expect(await pruneLifecycleData(NOW)).toEqual({
      sessions: 0,
      verifications: 0,
      notifications: 0,
      outbox: 0,
      mail: 0,
    });
    expect(sessions).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(verifications).toHaveBeenCalledExactlyOnceWith(NOW);
    expect(notifications).toHaveBeenCalledExactlyOnceWith(new Date(NOW.getTime() - 90 * DAY));
    expect(outbox).toHaveBeenCalledExactlyOnceWith(new Date(NOW.getTime() - 30 * DAY));
    sessions.mockResolvedValueOnce(2);
    const tomorrow = new Date(NOW.getTime() + DAY);
    expect(await pruneLifecycleData(tomorrow)).toMatchObject({ sessions: 2 });
    expect(sessions).toHaveBeenLastCalledWith(tomorrow);
    expect(outbox).toHaveBeenCalledTimes(2);
    expect(console.log).toHaveBeenCalledExactlyOnceWith("[lifecycle-retention] pruned 2 sessions");
  });

  it.each(["sessions", "verifications", "outbox", "notifications", "mail"] as const)(
    "recovers after a %s failure and still attempts the other categories",
    async (category) => {
      const mocks = { sessions, verifications, outbox, notifications, mail };
      mocks[category].mockRejectedValueOnce(new Error("synthetic private details"));
      await expect(pruneLifecycleData(NOW)).rejects.toThrow(
        `Lifecycle cleanup failed: ${category}`,
      );
      for (const mock of Object.values(mocks)) expect(mock).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledExactlyOnceWith(
        `[lifecycle-retention] ${category} cleanup failed`,
      );
      await expect(pruneLifecycleData(NOW)).resolves.toMatchObject({ [category]: 0 });
      for (const mock of Object.values(mocks)) expect(mock).toHaveBeenCalledTimes(2);
      expect(console.error).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves immediate and daily cleanup when the job queue cannot start", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let finish!: (value: number) => void;
    sessions.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const shutdown = vi.fn<BootContext["onShutdown"]>();
    const app = {} as Express;
    const ctx: BootContext = {
      env: "production",
      server: {} as BootContext["server"],
      onShutdown: shutdown,
    };

    await expect(registerJobs(app, ctx)).resolves.toBeUndefined();
    expect(shutdown).not.toHaveBeenCalled();
    await register(app, ctx);
    expect(sessions).toHaveBeenCalledExactlyOnceWith(NOW);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(sessions).toHaveBeenCalledTimes(1);
    expect(verifications).not.toHaveBeenCalled();
    finish(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(verifications).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(sessions).toHaveBeenLastCalledWith(new Date(NOW.getTime() + 2 * DAY));
    expect(sessions).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    const [stop] = shutdown.mock.calls[0]!;
    await stop();
    await stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(sessions).toHaveBeenCalledTimes(2);
  });
});
