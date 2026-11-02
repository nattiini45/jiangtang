import { describe, expect, it } from "vitest";
import {
  captureOrQueue,
  MemoryQueueStore,
  newClientId,
  replayQueue,
  type QueuedCapture,
} from "../offline-queue";
import { CUID_PATTERN } from "~/domains/transfer/transfer.schema";

/**
 * Offline capture queue logic — the store-agnostic rules, driven
 * through MemoryQueueStore and a fake fetch: submit-or-queue, then the
 * replay contract (2xx removes, 4xx keeps with the server's error,
 * network/5xx keeps silently).
 */

function fakeFetch(outcomes: (Response | Error)[], calls: string[] = []): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const o = outcomes[i++];
    if (o === undefined) throw new Error("fakeFetch: no more outcomes");
    if (o instanceof Error) throw o;
    return o;
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Exact single-fetch framing, as the running app sends it
// (POST /m/tasks/new.data): `text/x-script` with a turbo-stream body whose
// unflattened value is `{ data: <action result> }`.
const turbo = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/x-script; charset=utf-8" } });
const TURBO_ID = '[{"_1":2},"data",{"_3":4},"id","cabc12345678901234567890"]';
const TURBO_REFUSAL = '[{"_1":2},"data",{"_3":4},"error","Titel ist zu lang."]';

describe("offline queue", () => {
  it("newClientId mints the cuid shape the domains enforce", () => {
    for (let i = 0; i < 50; i++) expect(newClientId()).toMatch(CUID_PATTERN);
  });

  it("a successful submit is sent and carries the returned id", async () => {
    const store = new MemoryQueueStore();
    const res = await captureOrQueue(
      "/m/tasks/new",
      { title: "t" },
      store,
      fakeFetch([json({ id: "cabc12345678901234567890" })]),
    );
    expect(res).toMatchObject({ state: "sent", id: "cabc12345678901234567890" });
    expect(await store.list()).toHaveLength(0);
  });

  it("a network failure queues the entry with its clientId", async () => {
    const store = new MemoryQueueStore();
    const res = await captureOrQueue(
      "/m/tasks/new",
      { title: "t" },
      store,
      fakeFetch([new TypeError("fetch failed")]),
    );
    expect(res.state).toBe("queued");
    const [entry] = await store.list();
    expect(entry).toMatchObject({
      url: "/m/tasks/new",
      fields: { title: "t" },
      clientId: res.clientId,
    });
  });

  it("posts to the route's .data URL and keeps the surface path on the entry", async () => {
    const store = new MemoryQueueStore();
    const calls: string[] = [];
    const res = await captureOrQueue(
      "/m/tasks/new",
      { title: "t" },
      store,
      fakeFetch([new TypeError("fetch failed")], calls),
    );
    expect(res.state).toBe("queued");
    // A document POST renders HTML; the data request carries the action result.
    expect(calls).toEqual(["/m/tasks/new.data"]);
    const [entry] = await store.list();
    expect(entry.url).toBe("/m/tasks/new");
  });

  it("does not double-suffix an entry that already targets .data", async () => {
    const store = new MemoryQueueStore();
    const calls: string[] = [];
    await captureOrQueue(
      "/m/notes/new.data",
      { title: "n" },
      store,
      fakeFetch([new TypeError("fetch failed")], calls),
    );
    expect(calls).toEqual(["/m/notes/new.data"]);
  });

  it("decodes a single-fetch 2xx payload and carries the returned id", async () => {
    const store = new MemoryQueueStore();
    const res = await captureOrQueue(
      "/m/tasks/new",
      { title: "t" },
      store,
      fakeFetch([turbo(TURBO_ID)]),
    );
    expect(res).toMatchObject({ state: "sent", id: "cabc12345678901234567890" });
    expect(await store.list()).toHaveLength(0);
  });

  it("a 4xx refusal is NOT queued — the user sees it immediately", async () => {
    const store = new MemoryQueueStore();
    const res = await captureOrQueue(
      "/m/tasks/new",
      { title: "" },
      store,
      fakeFetch([json({ error: "Titel ist erforderlich." }, 400)]),
    );
    expect(res).toMatchObject({ state: "refused", error: "Titel ist erforderlich." });
    expect(await store.list()).toHaveLength(0);
  });

  it("replay: 2xx removes, 4xx keeps WITH the error, network keeps", async () => {
    const store = new MemoryQueueStore();
    const mk = (clientId: string): QueuedCapture => ({
      clientId,
      url: "/m/tasks/new",
      fields: { title: clientId },
      createdAt: 1,
    });
    await store.put(mk("ca11111111111111111111111"));
    await store.put(mk("cb22222222222222222222222"));
    await store.put(mk("cc33333333333333333333333"));

    const summary = await replayQueue(
      store,
      fakeFetch([
        json({ id: "ca11111111111111111111111" }), // sent → removed
        json({ error: "Titel ist erforderlich." }, 422), // refused → kept + error
        new TypeError("offline"), // retry → kept
      ]),
    );
    expect(summary).toEqual({ sent: 1, refused: 1, kept: 1 });

    const left = await store.list();
    expect(left.map((e) => e.clientId).sort()).toEqual([
      "cb22222222222222222222222",
      "cc33333333333333333333333",
    ]);
    expect(left.find((e) => e.clientId === "cb22222222222222222222222")?.error).toBe(
      "Titel ist erforderlich.",
    );
    expect(left.find((e) => e.clientId === "cc33333333333333333333333")?.error).toBeUndefined();
  });

  it("replay of a single-fetch 4xx keeps the entry with the message, never HTML", async () => {
    const store = new MemoryQueueStore();
    await store.put({
      clientId: "ce55555555555555555555555",
      url: "/m/tasks/new",
      fields: { title: "x".repeat(401) },
      createdAt: 1,
    });
    const summary = await replayQueue(store, fakeFetch([turbo(TURBO_REFUSAL, 400)]));
    expect(summary).toEqual({ sent: 0, refused: 1, kept: 0 });
    const [entry] = await store.list();
    expect(entry.error).toBe("Titel ist zu lang.");
    expect(entry.error).not.toContain("<!DOCTYPE");
  });

  it("replay keeps entries on a 5xx", async () => {
    const store = new MemoryQueueStore();
    await store.put({
      clientId: "cd44444444444444444444444",
      url: "/m/notes/new",
      fields: { title: "n" },
      createdAt: 1,
    });
    const summary = await replayQueue(store, fakeFetch([new Response("", { status: 500 })]));
    expect(summary).toEqual({ sent: 0, refused: 0, kept: 1 });
    expect(await store.list()).toHaveLength(1);
  });

  it("two concurrent replays share one pass — one POST per entry", async () => {
    const store = new MemoryQueueStore();
    await store.put({
      clientId: "cf66666666666666666666666",
      url: "/m/tasks/new",
      fields: { title: "t" },
      createdAt: 1,
    });
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowFetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      await gate;
      return json({ id: "cf66666666666666666666666" });
    }) as typeof fetch;
    const first = replayQueue(store, slowFetch);
    const second = replayQueue(store, slowFetch);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(1);
    expect(a).toEqual({ sent: 1, refused: 0, kept: 0 });
    expect(b).toEqual(a);
  });

  it("does not re-POST an entry that already carries a refusal", async () => {
    const store = new MemoryQueueStore();
    await store.put({
      clientId: "cg77777777777777777777777",
      url: "/m/tasks/new",
      fields: { title: "x".repeat(401) },
      createdAt: 1,
      error: "Titel ist zu lang.",
    });
    const calls: string[] = [];
    const summary = await replayQueue(store, fakeFetch([], calls));
    expect(calls).toHaveLength(0);
    expect(summary).toEqual({ sent: 0, refused: 0, kept: 1 });
    expect((await store.list())[0]?.error).toBe("Titel ist zu lang.");
  });
});
