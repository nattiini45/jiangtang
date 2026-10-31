import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "~/lib/db.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { broker } from "~/lib/realtime/listener.server";
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

describe("realtime broker — subscribe/emit/unsubscribe", () => {
  beforeAll(async () => {
    await broker.ensureStarted();
  });

  it("delivers an emitted event to a live subscriber", async () => {
    const sessionId = `sub-${Date.now()}`;
    const received = new Promise<RealtimeEvent>((resolve) => {
      broker.subscribe(sessionId, (ev) => resolve(ev));
    });

    const input = { entityType: "ticket", id: `t_${Date.now()}`, op: "created" } as const;
    // give the LISTEN connection a tick to be ready across processes
    await emitChange(input);

    const ev = await withTimeout(received, 5_000, "subscriber did not receive event");
    expect(ev.id).toBe(input.id);
    expect(ev.op).toBe("created");
  });

  it("stops delivering after unsubscribe", async () => {
    const sessionId = `gone-${Date.now()}`;
    let calls = 0;
    broker.subscribe(sessionId, () => {
      calls++;
    });
    broker.unsubscribe(sessionId);

    await emitChange({ entityType: "room", id: `r_${Date.now()}`, op: "updated" });
    // give the notification a moment to arrive (if it were going to)
    await new Promise((r) => setTimeout(r, 500));
    expect(calls).toBe(0);
  });
});
