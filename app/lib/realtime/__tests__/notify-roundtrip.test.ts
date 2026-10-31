import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { db } from "~/lib/db.server";
import { emitChange } from "~/lib/realtime/emit.server";
import {
  REALTIME_CHANNEL,
  decodeRealtimeEvent,
  encodeRealtimeEvent,
  type RealtimeEvent,
} from "~/lib/realtime/events";

afterAll(async () => {
  await db.$disconnect();
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

describe("realtime codec (frozen)", () => {
  it("round-trips an event", () => {
    const ev: RealtimeEvent = { entityType: "room", id: "r1", op: "updated", ts: 123 };
    expect(decodeRealtimeEvent(encodeRealtimeEvent(ev))).toEqual(ev);
  });
  it("rejects malformed payloads", () => {
    expect(() => decodeRealtimeEvent('{"id":"x"}')).toThrow();
    expect(() => decodeRealtimeEvent("not json")).toThrow();
  });
});

describe("NOTIFY → LISTEN round-trip", () => {
  it("emitChange delivers a decodable RealtimeEvent on the frozen channel", async () => {
    const listener = new Client({ connectionString: process.env.DATABASE_URL });
    await listener.connect();
    try {
      await listener.query(`LISTEN ${REALTIME_CHANNEL}`);

      const received = new Promise<string>((resolve) => {
        listener.on("notification", (msg) => {
          if (msg.channel === REALTIME_CHANNEL && msg.payload) resolve(msg.payload);
        });
      });

      const input = { entityType: "room", id: `room_${Date.now()}`, op: "updated" } as const;
      await emitChange(input);

      const payload = await withTimeout(received, 5_000, "NOTIFY not received");
      const decoded = decodeRealtimeEvent(payload);
      expect(decoded).toMatchObject(input);
      expect(typeof decoded.ts).toBe("number");
    } finally {
      await listener.end();
    }
  });
});
