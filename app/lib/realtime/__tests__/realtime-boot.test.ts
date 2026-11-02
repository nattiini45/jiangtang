import type { Express } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootContext } from "~/server/boot";

/**
 * The /api/realtime endpoint streams only to a signed-in, active user. The auth,
 * broker and SSE modules are mocked, so no database or socket is touched; the
 * route handler is captured from the Express stub and called directly.
 */

const { getSession, startSseStream, ensureStarted, findUnique, subscribe, resumeSince } =
  vi.hoisted(() => ({
    getSession: vi.fn(),
    startSseStream: vi.fn(),
    ensureStarted: vi.fn(async () => undefined),
    findUnique: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
    resumeSince: vi.fn(),
  }));

vi.mock("~/lib/auth.server", () => ({
  auth: { api: { getSession } },
}));

vi.mock("~/lib/db.server", () => ({
  db: { user: { findUnique } },
}));

vi.mock("~/lib/realtime/sse.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/realtime/sse.server")>();
  return { ...actual, startSseStream };
});

vi.mock("~/lib/realtime/listener.server", () => ({
  broker: { ensureStarted, stop: vi.fn(async () => undefined), subscribe, resumeSince },
}));

import { register } from "~/lib/realtime/realtime.boot.server";
import { CHECK_TIMEOUT_MS } from "~/lib/realtime/sse.server";

type RealtimeHandler = (req: unknown, res: unknown) => Promise<void>;

const PING_INTERVAL_MS = 15_000;

function context(): BootContext {
  return {
    env: "production",
    server: {} as BootContext["server"],
    onShutdown: () => undefined,
  };
}

async function mountedHandler(): Promise<RealtimeHandler> {
  let handler: RealtimeHandler | undefined;
  const app = {
    get: vi.fn((path: string, fn: RealtimeHandler) => {
      if (path === "/api/realtime") handler = fn;
    }),
  };
  await register(app as unknown as Express, context());
  if (!handler) throw new Error("/api/realtime was not mounted");
  return handler;
}

function fakeRequest() {
  return { headers: { cookie: "session_token=synthetic" } };
}

function fakeResponse() {
  const closeListeners: Array<() => void> = [];
  return {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === "close") closeListeners.push(cb);
    }),
    /** Simulates the client going away: every 'close' listener runs. */
    emitClose: () => closeListeners.forEach((cb) => cb()),
  };
}

/** A session lookup the test settles by hand, so it can be in flight during a disconnect. */
function pendingLookup() {
  let settle: (session: unknown) => void = () => undefined;
  let fail: (err: Error) => void = () => undefined;
  getSession.mockReturnValue(
    new Promise((resolve, reject) => {
      settle = resolve;
      fail = reject;
    }),
  );
  return { settle, fail };
}

let consoleError: { mockRestore: () => void } & ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined) as typeof consoleError;
});

afterEach(() => {
  consoleError.mockRestore();
  vi.useRealTimers();
});

describe("/api/realtime", () => {
  it("answers a clean empty stream with a retry hint when the session lookup never settles", async () => {
    getSession.mockReturnValue(new Promise(() => undefined));
    const handler = await mountedHandler();
    const res = fakeResponse();
    vi.useFakeTimers();

    const answered = handler(fakeRequest(), res);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS - 1);
    expect(res.writeHead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await answered;

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "text/event-stream" }),
    );
    expect(res.end).toHaveBeenCalledWith("retry: 5000\n\n");
    expect(startSseStream).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("session lookup failed"),
      `timed out after ${CHECK_TIMEOUT_MS} ms`,
    );
  });

  it("answers a clean empty stream with a retry hint when the session lookup throws", async () => {
    getSession.mockRejectedValue(new Error("database unavailable"));
    const handler = await mountedHandler();
    const res = fakeResponse();

    // Resolving at all is the point: a rejected handler leaves the request hanging.
    await handler(fakeRequest(), res);

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ "Content-Type": "text/event-stream" }),
    );
    expect(res.end).toHaveBeenCalledWith("retry: 5000\n\n");
    expect(startSseStream).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("session lookup failed"),
      "database unavailable",
    );
  });

  it("answers 401 for an anonymous request and streams nothing", async () => {
    getSession.mockResolvedValue(null);
    const handler = await mountedHandler();
    const res = fakeResponse();

    await handler(fakeRequest(), res);

    expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
    expect(startSseStream).not.toHaveBeenCalled();
  });

  it("answers 401 for a deactivated user, even with a valid session", async () => {
    getSession.mockResolvedValue({ user: { id: "user-1", isActive: false } });
    const handler = await mountedHandler();
    const res = fakeResponse();

    await handler(fakeRequest(), res);

    expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
    expect(startSseStream).not.toHaveBeenCalled();
  });

  it("writes no retry answer when the client disconnects before a failed lookup settles", async () => {
    const lookup = pendingLookup();
    const handler = await mountedHandler();
    const res = fakeResponse();

    const answered = handler(fakeRequest(), res);
    res.emitClose();
    lookup.fail(new Error("database unavailable"));
    await answered;

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(startSseStream).not.toHaveBeenCalled();
  });

  it("writes no 401 when the client disconnects before an anonymous lookup settles", async () => {
    const lookup = pendingLookup();
    const handler = await mountedHandler();
    const res = fakeResponse();

    const answered = handler(fakeRequest(), res);
    res.emitClose();
    lookup.settle(null);
    await answered;

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(startSseStream).not.toHaveBeenCalled();
  });

  it("leaves no ping interval or broker subscription when the client disconnects during an active user's lookup", async () => {
    const actualSse = await vi.importActual<typeof import("~/lib/realtime/sse.server")>(
      "~/lib/realtime/sse.server",
    );
    const lookup = pendingLookup();
    startSseStream.mockImplementation(actualSse.startSseStream);
    vi.useFakeTimers();
    try {
      const handler = await mountedHandler();
      const res = fakeResponse();

      const answered = handler(fakeRequest(), res);
      res.emitClose();
      lookup.settle({ user: { id: "user-6", isActive: true } });
      await answered;

      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 2);
      expect(subscribe).not.toHaveBeenCalled();
      expect(res.write).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      startSseStream.mockReset();
    }
  });

  it("starts the stream for an active user", async () => {
    getSession.mockResolvedValue({ user: { id: "user-2", isActive: true } });
    const handler = await mountedHandler();
    const req = fakeRequest();
    const res = fakeResponse();

    await handler(req, res);

    expect(res.writeHead).not.toHaveBeenCalled();
    expect(startSseStream).toHaveBeenCalledWith(req, res, expect.any(Function));
  });

  it("gives the stream a liveness check that reads the account row by session user id", async () => {
    getSession.mockResolvedValue({ user: { id: "user-3", isActive: true } });
    const handler = await mountedHandler();

    await handler(fakeRequest(), fakeResponse());

    const liveness = startSseStream.mock.calls[0][2] as () => Promise<boolean>;
    findUnique.mockResolvedValueOnce({ isActive: true });
    await expect(liveness()).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "user-3" },
      select: { isActive: true },
    });
  });

  it("reports a deactivated account as no longer active", async () => {
    getSession.mockResolvedValue({ user: { id: "user-4", isActive: true } });
    const handler = await mountedHandler();

    await handler(fakeRequest(), fakeResponse());

    const liveness = startSseStream.mock.calls[0][2] as () => Promise<boolean>;
    findUnique.mockResolvedValueOnce({ isActive: false });
    await expect(liveness()).resolves.toBe(false);
  });

  it("treats a missing account row as no longer active", async () => {
    getSession.mockResolvedValue({ user: { id: "user-5", isActive: true } });
    const handler = await mountedHandler();

    await handler(fakeRequest(), fakeResponse());

    const liveness = startSseStream.mock.calls[0][2] as () => Promise<boolean>;
    findUnique.mockResolvedValueOnce(null);
    await expect(liveness()).resolves.toBe(false);
  });
});
