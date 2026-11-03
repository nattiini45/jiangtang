import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * broker recovery, isolated from the DB-backed listener.test.ts /
 * sse-resume.test.ts (which exercise the broker against a real Postgres LISTEN
 * channel). Here `pg.Client` is mocked so we can force a failing first connect —
 * not reproducible against a real, healthy dev DB — and assert the broker
 * self-heals instead of wedging forever.
 */

interface FakeClient extends EventEmitter {
  connect: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

let instances: FakeClient[] = [];
let connectBehavior: Array<() => Promise<void>> = [];

function makeFakeClient(): FakeClient {
  const emitter = new EventEmitter() as FakeClient;
  emitter.connect = vi.fn(async () => {
    const step = connectBehavior.shift();
    if (step) await step();
  });
  emitter.query = vi.fn(async () => undefined);
  emitter.end = vi.fn(async () => undefined);
  instances.push(emitter);
  return emitter;
}

// Vitest 4 only lets a mock be called with `new` when its implementation is a
// plain function, so this is not an arrow function.
vi.mock("pg", () => ({
  Client: vi.fn().mockImplementation(function () {
    return makeFakeClient();
  }),
}));

describe("RealtimeBroker reconnect behavior (mocked pg.Client)", () => {
  beforeEach(() => {
    vi.resetModules();
    instances = [];
    connectBehavior = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers after the initial connect() rejects, instead of wedging forever", async () => {
    const { broker } = await import("~/lib/realtime/listener.server");

    connectBehavior.push(async () => {
      throw new Error("ECONNREFUSED (db not ready)");
    });
    connectBehavior.push(async () => undefined); // second attempt succeeds

    // First call: initial connect fails. Must NOT throw past ensureStarted (a
    // boot-time DB hiccup should schedule a retry, not crash the process).
    await expect(broker.ensureStarted()).resolves.toBeUndefined();
    expect(instances).toHaveLength(1);

    // A second call to ensureStarted before the backoff timer fires must not be
    // stuck returning the same permanently-rejected promise (there is none to
    // return — `starting` was reset), and must not spawn a redundant client since
    // a reconnect is already scheduled.
    await expect(broker.ensureStarted()).resolves.toBeUndefined();

    // Advance past the backoff delay so the scheduled retry fires.
    await vi.runOnlyPendingTimersAsync();

    expect(instances).toHaveLength(2);
    expect(instances[1].query).toHaveBeenCalledWith(expect.stringContaining("LISTEN"));

    await broker.stop();
  });

  it("a reconnect tears down (removeAllListeners + end) the superseded client", async () => {
    const { broker } = await import("~/lib/realtime/listener.server");

    connectBehavior.push(async () => undefined); // first connect succeeds

    await broker.ensureStarted();
    expect(instances).toHaveLength(1);
    const first = instances[0];
    const removeAllSpy = vi.spyOn(first, "removeAllListeners");

    connectBehavior.push(async () => undefined); // reconnect after error succeeds

    // Simulate a connection-loss on the live client.
    first.emit("error", new Error("connection terminated"));

    // ensureStarted() should now retry (error handler clears `starting`/`client`
    // and schedules a backed-off reconnect).
    await vi.runOnlyPendingTimersAsync();

    expect(instances).toHaveLength(2);
    expect(removeAllSpy).toHaveBeenCalled();
    expect(first.end).toHaveBeenCalled();

    await broker.stop();
  });

  it("pushes a synthetic resync event to live subscribers after a reconnect", async () => {
    const { broker } = await import("~/lib/realtime/listener.server");

    connectBehavior.push(async () => undefined); // first connect succeeds
    await broker.ensureStarted();

    const received: Array<{ entityType: string; id: string }> = [];
    broker.subscribe("sub-1", (ev) => received.push(ev));

    connectBehavior.push(async () => undefined); // reconnect succeeds
    instances[0].emit("error", new Error("connection terminated"));
    await vi.runOnlyPendingTimersAsync();

    // The first successful start must NOT itself have pushed a resync (nothing to
    // resync from yet); only the *re*connect should.
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe("resync");

    await broker.stop();
  });
});
