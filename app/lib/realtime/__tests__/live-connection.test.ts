import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROBE_TIMEOUT_MS,
  connectLive,
  probeStream,
  reconnectDelayMs,
  type LiveEventSource,
  type ProbeResult,
} from "~/lib/realtime/live-connection";

/**
 * The browser side of the live-update stream, driven with a fake EventSource and
 * fake timers. A real EventSource gives up for good once the server answers
 * anything but a 200 event stream, so the connection must rebuild it itself.
 */

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeEventSource implements LiveEventSource {
  readyState = CONNECTING;
  closed = false;
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, cb: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(cb);
  }

  removeEventListener(type: string, cb: () => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
  }

  emit(type: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb();
  }

  open(): void {
    this.readyState = OPEN;
    this.emit("open");
  }

  /** What a browser does after a non-200 answer: error, and the source is closed. */
  failFatally(): void {
    this.readyState = CLOSED;
    this.emit("error");
  }

  /** What a browser does after a network drop: error, then it retries on its own. */
  dropAndRetry(): void {
    this.readyState = CONNECTING;
    this.emit("error");
  }
}

function setup(probeResults: ProbeResult[] = []) {
  const sources: FakeEventSource[] = [];
  const revalidate = vi.fn();
  const probe = vi.fn(async (): Promise<ProbeResult> => probeResults.shift() ?? "retry");
  const conn = connectLive({
    url: "/api/realtime",
    createEventSource: () => {
      const es = new FakeEventSource();
      sources.push(es);
      return es;
    },
    onRevalidate: revalidate,
    probe,
    random: () => 0.5,
  });
  return { sources, revalidate, probe, conn, latest: () => sources[sources.length - 1]! };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconnectDelayMs", () => {
  it("grows exponentially from one second and caps at thirty", () => {
    const mid = (): number => 0.5;
    expect(reconnectDelayMs(0, mid)).toBe(1_000);
    expect(reconnectDelayMs(1, mid)).toBe(2_000);
    expect(reconnectDelayMs(3, mid)).toBe(8_000);
    expect(reconnectDelayMs(10, mid)).toBe(30_000);
    expect(reconnectDelayMs(50, mid)).toBe(30_000);
  });

  it("spreads clients with jitter so a deploy does not cause a reconnect storm", () => {
    expect(reconnectDelayMs(3, () => 0)).toBe(6_400);
    expect(reconnectDelayMs(3, () => 1)).toBe(9_600);
  });
});

describe("connectLive", () => {
  it("revalidates on open and on every change", () => {
    const { latest, revalidate } = setup();
    latest().open();
    latest().emit("change");
    expect(revalidate).toHaveBeenCalledTimes(2);
  });

  it("lets the browser ride out a plain network drop", async () => {
    const { sources, latest, probe } = setup();
    latest().open();
    latest().dropAndRetry();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probe).not.toHaveBeenCalled();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.closed).toBe(false);
  });

  it("rebuilds the stream after a fatal error and revalidates once it is back", async () => {
    const { sources, latest, revalidate } = setup(["retry"]);
    latest().open();
    revalidate.mockClear();

    latest().failFatally();
    expect(sources[0]!.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(2);

    latest().open();
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("backs off further on each failed attempt and resets after a successful open", async () => {
    const { sources, latest } = setup(["retry", "retry", "retry", "retry"]);
    latest().failFatally();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources).toHaveLength(2);

    latest().failFatally();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sources).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sources).toHaveLength(3);

    latest().open();
    latest().failFatally();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources).toHaveLength(4);
  });

  it("stops for good when the server says the session is gone", async () => {
    const { sources, latest, probe } = setup(["unauthorized"]);
    latest().failFatally();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sources).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps retrying while the probe itself fails, as during a deploy", async () => {
    const { sources, latest, probe } = setup(["retry", "retry", "retry"]);
    latest().failFatally();
    await vi.advanceTimersByTimeAsync(1_000);
    latest().failFatally();
    await vi.advanceTimersByTimeAsync(2_000);
    latest().failFatally();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sources).toHaveLength(4);
  });

  it("reconnects at once when the browser comes back online", async () => {
    const { sources, latest, conn } = setup(["retry"]);
    latest().failFatally();
    await vi.advanceTimersByTimeAsync(10);
    conn.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(sources).toHaveLength(2);
    // The pending backoff timer is cancelled, so it does not open a third source.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources).toHaveLength(2);
  });

  it("closes everything and schedules nothing more after close()", async () => {
    const { sources, latest, conn, revalidate } = setup(["retry"]);
    latest().failFatally();
    conn.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    sources[0]!.emit("change");
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("ignores a probe that settles after close()", async () => {
    let settle: (r: ProbeResult) => void = () => undefined;
    const sources: FakeEventSource[] = [];
    const conn = connectLive({
      url: "/api/realtime",
      createEventSource: () => {
        const es = new FakeEventSource();
        sources.push(es);
        return es;
      },
      onRevalidate: () => undefined,
      probe: () => new Promise<ProbeResult>((r) => (settle = r)),
      random: () => 0.5,
    });
    sources[0]!.failFatally();
    conn.close();
    settle("retry");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources).toHaveLength(1);
  });
});

describe("connectLive (probe edge cases)", () => {
  it("treats a probe that rejects like any other non-401 outcome", async () => {
    const sources: FakeEventSource[] = [];
    connectLive({
      url: "/api/realtime",
      createEventSource: () => {
        const es = new FakeEventSource();
        sources.push(es);
        return es;
      },
      onRevalidate: () => undefined,
      probe: () => Promise.reject(new Error("network down")),
      random: () => 0.5,
    });
    sources[0]!.failFatally();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources).toHaveLength(2);
  });

  it("starts the backoff from one second again after reconnectNow", async () => {
    const { sources, latest, conn } = setup(["retry", "retry", "retry", "retry", "retry"]);
    for (let i = 0; i < 4; i++) {
      latest().failFatally();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(sources).toHaveLength(5);
    latest().failFatally();
    await vi.advanceTimersByTimeAsync(10);
    conn.reconnectNow();
    expect(sources).toHaveLength(6);
    latest().failFatally();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sources).toHaveLength(7);
  });

  it("aborts a probe that is still in flight on close()", async () => {
    let seen: AbortSignal | undefined;
    const sources: FakeEventSource[] = [];
    const conn = connectLive({
      url: "/api/realtime",
      createEventSource: () => {
        const es = new FakeEventSource();
        sources.push(es);
        return es;
      },
      onRevalidate: () => undefined,
      probe: (_url, signal) => {
        seen = signal;
        return new Promise<ProbeResult>(() => undefined);
      },
      random: () => 0.5,
    });
    sources[0]!.failFatally();
    expect(seen?.aborted).toBe(false);
    conn.close();
    expect(seen?.aborted).toBe(true);
  });
});

describe("probeStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a 401 or 403 as unauthorized and anything else as retry", async () => {
    for (const [status, expected] of [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [200, "retry"],
      [502, "retry"],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status })),
      );
      await expect(probeStream("/api/realtime", new AbortController().signal)).resolves.toBe(
        expected,
      );
    }
  });

  it("returns retry on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(probeStream("/api/realtime", new AbortController().signal)).resolves.toBe("retry");
  });

  it("gives up waiting after a few seconds and aborts the request", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init.signal ?? undefined;
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted")));
          }),
      ),
    );
    const result = probeStream("/api/realtime", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    await expect(result).resolves.toBe("retry");
    expect(requestSignal?.aborted).toBe(true);
  });
});
