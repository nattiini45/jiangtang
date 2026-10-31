import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { broker } from "~/lib/realtime/listener.server";
import { startSseStream } from "~/lib/realtime/sse.server";
import type { RealtimeEvent } from "~/lib/realtime/events";

afterAll(async () => {
  await broker.stop();
  await db.$disconnect();
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

/** Minimal mock of the Express `res` surface `startSseStream` touches. */
function mockRes() {
  const chunks: string[] = [];
  const closeHandlers: Array<() => void> = [];
  return {
    chunks,
    writeHead: () => undefined,
    write: (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    },
    on: (_event: "close", cb: () => void) => closeHandlers.push(cb),
    end: () => undefined,
    _close: () => closeHandlers.forEach((cb) => cb()),
  };
}

/** Poll the ring buffer until `id` is present; return its event. */
async function waitForEvent(id: string): Promise<RealtimeEvent> {
  return withTimeout(
    (async () => {
      for (let i = 0; i < 60; i++) {
        const seen: RealtimeEvent[] = [];
        broker.resumeSince(0, (ev) => seen.push(ev));
        const hit = seen.find((e) => e.id === id);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`${id} never reached the ring buffer`);
    })(),
    6_000,
    `wait for ${id}`,
  );
}

describe("SSE stream — Last-Event-ID resume", () => {
  beforeAll(async () => {
    await broker.ensureStarted();
  });

  it("replays buffered events newer than Last-Event-ID on connect", async () => {
    const idA = `a_${Date.now()}`;
    const idB = `b_${Date.now()}`;

    await emitChange({ entityType: "room", id: idA, op: "updated" });
    const evA = await waitForEvent(idA);
    await new Promise((r) => setTimeout(r, 15)); // ensure ts strictly increases
    await emitChange({ entityType: "room", id: idB, op: "updated" });
    const evB = await waitForEvent(idB);
    expect(evB.ts).toBeGreaterThan(evA.ts);

    // Connect with Last-Event-ID = evA.ts: only evB should be replayed.
    const res = mockRes();
    startSseStream({ headers: { "last-event-id": String(evA.ts) } }, res);

    const combined = res.chunks.join("");
    expect(combined).toContain(idB);
    // evA is the resume point — it must NOT be replayed.
    const aFrame = combined.split("\n\n").find((frame) => frame.includes(`"id":"${idA}"`));
    expect(aFrame).toBeUndefined();
  });

  it("writes a well-formed SSE frame when a live event arrives", async () => {
    const res = mockRes();
    // Subscribe first, THEN emit, so the live push is captured by startSseStream's
    // own subscriber (no race).
    startSseStream({ headers: {} }, res);

    const id = `live_${Date.now()}`;
    await emitChange({ entityType: "ticket", id, op: "created" });

    // Poll res.chunks for the live frame to land (NOTIFY → broker → subscriber).
    await withTimeout(
      (async () => {
        for (let i = 0; i < 60; i++) {
          if (res.chunks.join("").includes(id)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error("live frame never arrived");
      })(),
      6_000,
      "live frame",
    );

    const combined = res.chunks.join("");
    // Frames carry id/event/data lines terminated by a blank line.
    expect(combined).toMatch(/id: \d+\nevent: change\ndata: .+\n\n/);
    expect(combined).toContain(id);

    // Cleanup must tear down the subscriber so it doesn't leak across tests.
    res._close();
  });
});
