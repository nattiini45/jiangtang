import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Liveness re-checks on an open SSE stream. The broker is mocked, so the stream
 * is driven entirely by fake timers and no database or socket is touched.
 */

const { subscribe, resumeSince, unsubscribe } = vi.hoisted(() => {
  const unsubscribe = vi.fn();
  return { unsubscribe, subscribe: vi.fn(() => unsubscribe), resumeSince: vi.fn() };
});

vi.mock("~/lib/realtime/listener.server", () => ({
  broker: { subscribe, resumeSince },
}));

import { checkWithTimeout, startSseStream } from "~/lib/realtime/sse.server";

const PING_INTERVAL_MS = 15_000;
const CHECK_TIMEOUT_MS = 5_000;

function mockRes() {
  const chunks: string[] = [];
  return {
    chunks,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }),
    on: vi.fn(),
    end: vi.fn(),
  };
}

let consoleError: { mockRestore: () => void } & ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined) as typeof consoleError;
});

afterEach(() => {
  consoleError.mockRestore();
  vi.useRealTimers();
});

describe("checkWithTimeout", () => {
  it("resolves with the check's value and leaves no timer behind", async () => {
    await expect(checkWithTimeout(async () => "value", CHECK_TIMEOUT_MS)).resolves.toBe("value");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("SSE stream liveness re-check", () => {
  it("keeps an active stream open across heartbeats", async () => {
    const res = mockRes();
    const isStillActive = vi.fn(async () => true);

    startSseStream({ headers: {} }, res, isStillActive);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3);

    expect(isStillActive).toHaveBeenCalledTimes(3);
    expect(res.end).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("ends the stream on the first heartbeat after the check turns false, and stops pinging", async () => {
    const res = mockRes();
    let active = true;
    const isStillActive = vi.fn(async () => active);

    startSseStream({ headers: {} }, res, isStillActive);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(res.end).not.toHaveBeenCalled();

    active = false;
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    const writesAfterEnd = res.write.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
    expect(res.write.mock.calls.length).toBe(writesAfterEnd);
    expect(isStillActive).toHaveBeenCalledTimes(2);
  });

  it("fails closed: a rejected check ends the stream and logs the error", async () => {
    const res = mockRes();
    const isStillActive = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    startSseStream({ headers: {} }, res, isStillActive);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("liveness check failed"),
      "database unavailable",
    );
  });

  it("ends a stream whose check never settles once the timeout passes", async () => {
    const res = mockRes();
    const isStillActive = vi.fn(() => new Promise<boolean>(() => undefined));

    startSseStream({ headers: {} }, res, isStillActive);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + CHECK_TIMEOUT_MS - 1);
    expect(res.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("liveness check failed"),
      expect.stringContaining("timed out"),
    );
  });

  it("stops checking once a hung check has ended the stream", async () => {
    const res = mockRes();
    const isStillActive = vi.fn(() => new Promise<boolean>(() => undefined));

    startSseStream({ headers: {} }, res, isStillActive);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + CHECK_TIMEOUT_MS);
    expect(res.end).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
    expect(isStillActive).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("raises no unhandled rejection when a check fails after it has timed out", async () => {
    const res = mockRes();
    let fail: (err: Error) => void = () => undefined;
    const isStillActive = vi.fn(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          fail = reject;
        }),
    );

    startSseStream({ headers: {} }, res, isStillActive);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS + CHECK_TIMEOUT_MS);
    expect(res.end).toHaveBeenCalledTimes(1);

    fail(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(0);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("keeps the stream writing heartbeats and never checks when no check is given", async () => {
    const res = mockRes();

    startSseStream({ headers: {} }, res);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);

    expect(res.end).not.toHaveBeenCalled();
    expect(res.chunks.filter((c) => c.startsWith(": ping ")).length).toBe(2);
  });
});
