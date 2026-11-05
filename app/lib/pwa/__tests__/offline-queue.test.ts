import { createRequestHandler, redirect, type ServerBuild } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_OWNER_HEADER,
  captureOrQueue,
  MemoryQueueStore,
  newClientId,
  QUEUE_CHANGED_EVENT,
  replayQueue,
  visibleEntries,
  type QueuedCapture,
} from "../offline-queue";
import { CUID_PATTERN } from "~/domains/transfer/transfer.schema";

/**
 * Offline capture queue logic — the store-agnostic rules, driven
 * through MemoryQueueStore and a fake fetch: submit-or-queue, then the
 * replay contract (2xx removes, 4xx keeps with the server's error,
 * network/5xx keeps silently, an authentication wall keeps and stops the pass).
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

// The response an expired session really produces: React Router's own request
// handler runs a `.data` POST against an action that throws `redirect(target)`
// (what `requireUser` does), so status, headers and the turbo-stream body come
// from the real encoder rather than a hand-written fixture.
async function singleFetchRedirect(target: string): Promise<Response> {
  const build = {
    entry: { module: { default: () => new Response("document") } },
    routes: {
      root: { id: "root", path: "", module: { default: () => null } },
      "m/tasks/new": {
        id: "m/tasks/new",
        parentId: "root",
        path: "m/tasks/new",
        module: {
          default: () => null,
          action: () => {
            throw redirect(target);
          },
        },
      },
    },
    assets: { version: "test", entry: { module: "", imports: [] }, routes: {}, url: "" },
    future: {},
    ssr: true,
    publicPath: "/",
    basename: "/",
    isSpaMode: false,
    routeDiscovery: { mode: "initial" },
    allowedActionOrigins: false,
  } as unknown as ServerBuild;
  return createRequestHandler(
    build,
    "test",
  )(
    new Request("http://localhost/m/tasks/new.data", {
      method: "POST",
      body: new URLSearchParams({ title: "t" }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    }),
  );
}

// fetch followed a redirect: the platform sets `redirected` and the final `url`.
function followed(url: string, status = 200): Response {
  const res = new Response("<!doctype html>", { status, headers: { "content-type": "text/html" } });
  Object.defineProperty(res, "redirected", { value: true });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

const ENTRY_ID = "c9a9a9a9a9a9a9a9a9a9a9a9a";
const mkEntry = (clientId: string, createdAt = 1): QueuedCapture => ({
  clientId,
  url: "/m/tasks/new",
  fields: { title: clientId },
  createdAt,
});

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

  describe("authentication wall", () => {
    const walls: [string, () => Promise<Response> | Response][] = [
      [
        "a single-fetch redirect to /login",
        () => singleFetchRedirect("/login?next=%2Fm%2Ftasks%2Fnew"),
      ],
      [
        "a single-fetch redirect to /login for a deactivated user",
        () => singleFetchRedirect("/login?deactivated=1"),
      ],
      [
        "a followed redirect to the /login page",
        () => followed("http://localhost/login?next=%2Fm"),
      ],
      ["HTTP 401", () => new Response("Unauthorized", { status: 401 })],
      ["HTTP 403", () => new Response("Forbidden", { status: 403 })],
    ];

    it("the single-fetch redirect fixture is what React Router really answers", async () => {
      const res = await singleFetchRedirect("/login?next=%2Fm");
      expect(res.status).toBe(202);
      expect(res.headers.get("content-type")).toContain("text/x-script");
    });

    for (const [label, wall] of walls) {
      it(`captureOrQueue queues ${label} and asks for sign-in`, async () => {
        const store = new MemoryQueueStore();
        const res = await captureOrQueue(
          "/m/tasks/new",
          { title: "t" },
          store,
          fakeFetch([await wall()]),
        );
        expect(res).toMatchObject({ state: "queued", authRequired: true });
        const [entry] = await store.list();
        expect(entry).toMatchObject({ clientId: res.clientId, fields: { title: "t" } });
        // Waiting for a sign-in is not a refusal: replay must still try it.
        expect(entry.error).toBeUndefined();
        expect(entry.authRequired).toBe(true);
      });

      it(`replay keeps an entry that meets ${label}, without an error`, async () => {
        const store = new MemoryQueueStore();
        await store.put(mkEntry(ENTRY_ID));
        const summary = await replayQueue(store, fakeFetch([await wall()]));
        expect(summary).toEqual({ sent: 0, refused: 0, kept: 1, authRequired: true });
        const [entry] = await store.list();
        expect(entry.clientId).toBe(ENTRY_ID);
        expect(entry.error).toBeUndefined();
        expect(entry.authRequired).toBe(true);
      });
    }

    it("the replay pass stops at the first wall and never requests the later entries", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry("ca11111111111111111111111", 1));
      await store.put(mkEntry("cb22222222222222222222222", 2));
      await store.put(mkEntry("cc33333333333333333333333", 3));
      const calls: string[] = [];
      const summary = await replayQueue(
        store,
        fakeFetch(
          [
            json({ id: "ca11111111111111111111111" }), // sent → removed
            await singleFetchRedirect("/login?next=%2Fm%2Ftasks%2Fnew"), // wall
            json({ id: "cc33333333333333333333333" }), // must never be requested
          ],
          calls,
        ),
      );
      expect(calls).toHaveLength(2);
      expect(summary).toEqual({ sent: 1, refused: 0, kept: 2, authRequired: true });
      const left = await store.list();
      expect(left.map((e) => e.clientId)).toEqual([
        "cb22222222222222222222222",
        "cc33333333333333333333333",
      ]);
      expect(left.every((e) => e.error === undefined)).toBe(true);
    });

    it("a wall flags every entry still waiting, not only the one that met it", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry("ca11111111111111111111111", 1));
      await store.put(mkEntry("cb22222222222222222222222", 2));
      await store.put(mkEntry("cc33333333333333333333333", 3));
      await replayQueue(store, fakeFetch([new Response("", { status: 401 })]));
      expect((await store.list()).map((e) => e.authRequired)).toEqual([true, true, true]);
    });

    it("discarding the entry that met the wall leaves the rest of the queue asking for sign-in", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry("ca11111111111111111111111", 1));
      await store.put(mkEntry("cb22222222222222222222222", 2));
      await replayQueue(store, fakeFetch([new Response("", { status: 401 })]));
      await store.remove("ca11111111111111111111111");
      const left = await store.list();
      expect(left).toHaveLength(1);
      expect(left.some((e) => e.authRequired)).toBe(true);
    });

    it("a wall flags an earlier entry that only failed for a transient reason", async () => {
      // c1 got a 503, c2 met the wall: both still sit behind the expired session.
      const store = new MemoryQueueStore();
      await store.put(mkEntry("ca11111111111111111111111", 1));
      await store.put(mkEntry("cb22222222222222222222222", 2));
      await replayQueue(
        store,
        fakeFetch([new Response("", { status: 503 }), new Response("", { status: 401 })]),
      );
      expect((await store.list()).map((e) => e.authRequired)).toEqual([true, true]);
    });

    it("a wall does not flag a refused entry, which waits for the user and not for a sign-in", async () => {
      const store = new MemoryQueueStore();
      await store.put({ ...mkEntry("ca11111111111111111111111", 1), error: "Titel ist zu lang." });
      await store.put(mkEntry("cb22222222222222222222222", 2));
      await replayQueue(store, fakeFetch([new Response("", { status: 401 })]));
      const [refused, waiting] = await store.list();
      expect(refused?.authRequired).toBeUndefined();
      expect(waiting?.authRequired).toBe(true);
    });

    it("a sent entry clears the flag from every entry, also when another entry failed transiently", async () => {
      // After sign-in: c1 gets a 503 (says nothing about the session), c2 is
      // sent. The session works, so c1 must not keep asking for a sign-in.
      const store = new MemoryQueueStore();
      await store.put({ ...mkEntry("ca11111111111111111111111", 1), authRequired: true });
      await store.put({ ...mkEntry("cb22222222222222222222222", 2), authRequired: true });
      await store.put({ ...mkEntry("cc33333333333333333333333", 3), authRequired: true });
      const summary = await replayQueue(
        store,
        fakeFetch([
          new Response("", { status: 503 }),
          json({ id: "cb22222222222222222222222" }),
          new TypeError("offline"),
        ]),
      );
      expect(summary).toEqual({ sent: 1, refused: 0, kept: 2 });
      const left = await store.list();
      expect(left.map((e) => e.clientId)).toEqual([
        "ca11111111111111111111111",
        "cc33333333333333333333333",
      ]);
      expect(left.every((e) => e.authRequired === undefined)).toBe(true);
    });

    it("a refusal clears the flag from the other entries too", async () => {
      const store = new MemoryQueueStore();
      await store.put({ ...mkEntry("ca11111111111111111111111", 1), authRequired: true });
      await store.put({ ...mkEntry("cb22222222222222222222222", 2), authRequired: true });
      await replayQueue(
        store,
        fakeFetch([json({ error: "Titel ist zu lang." }, 400), new Response("", { status: 503 })]),
      );
      const [first, second] = await store.list();
      expect(first?.error).toBe("Titel ist zu lang.");
      expect(first?.authRequired).toBeUndefined();
      expect(second?.authRequired).toBeUndefined();
    });

    it("a wall after a send wins: what is left still waits for the sign-in", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry("ca11111111111111111111111", 1));
      await store.put(mkEntry("cb22222222222222222222222", 2));
      await store.put({ ...mkEntry("cc33333333333333333333333", 3), authRequired: true });
      await replayQueue(
        store,
        fakeFetch([json({ id: "ca11111111111111111111111" }), new Response("", { status: 401 })]),
      );
      expect((await store.list()).map((e) => e.authRequired)).toEqual([true, true]);
    });

    it("only the current user's flags change", async () => {
      const store = new MemoryQueueStore();
      const theirs = {
        ...mkEntry("cb22222222222222222222222", 2),
        userId: "cuserbob00000000000000002",
        authRequired: true,
      };
      await store.put({
        ...mkEntry("ca11111111111111111111111", 1),
        userId: "cuseralice000000000000001",
        authRequired: true,
      });
      await store.put(theirs);
      await replayQueue(
        store,
        fakeFetch([json({ id: "ca11111111111111111111111" })]),
        "cuseralice000000000000001",
      );
      expect(await store.list()).toEqual([theirs]);
    });

    it("an entry that waited for sign-in is sent and removed once the session is back", async () => {
      const store = new MemoryQueueStore();
      await store.put({ ...mkEntry(ENTRY_ID), authRequired: true });
      const summary = await replayQueue(store, fakeFetch([json({ id: ENTRY_ID })]));
      expect(summary).toEqual({ sent: 1, refused: 0, kept: 0 });
      expect(await store.list()).toHaveLength(0);
    });

    it("keeps the sign-in marker when a later pass fails for a reason that says nothing about the session", async () => {
      // A network error, a 5xx and an unconfirmed redirect are all
      // inconclusive: the session may still be gone.
      const store = new MemoryQueueStore();
      await store.put({ ...mkEntry(ENTRY_ID), authRequired: true });
      for (const outcome of [
        new Response("", { status: 503 }),
        new TypeError("offline"),
        await singleFetchRedirect("/m/rooms"),
        followed("http://localhost/m/rooms"),
      ]) {
        await replayQueue(store, fakeFetch([outcome]));
        const [entry] = await store.list();
        expect(entry.authRequired).toBe(true);
        expect(entry.error).toBeUndefined();
      }
    });

    it("drops a stale sign-in marker when the action answers with a refusal", async () => {
      // A validation refusal comes from the action itself, so the session works.
      const store = new MemoryQueueStore();
      await store.put({ ...mkEntry(ENTRY_ID), authRequired: true });
      const summary = await replayQueue(
        store,
        fakeFetch([json({ error: "Titel ist zu lang." }, 400)]),
      );
      expect(summary).toEqual({ sent: 0, refused: 1, kept: 0 });
      const [entry] = await store.list();
      expect(entry.error).toBe("Titel ist zu lang.");
      expect(entry.authRequired).toBeUndefined();
    });

    describe("a 202 that is not a confirmed redirect to /login", () => {
      const odd: [string, () => Response][] = [
        ["has an empty body", () => new Response("", { status: 202 })],
        [
          "is not a single-fetch body",
          () =>
            new Response("accepted", { status: 202, headers: { "content-type": "text/plain" } }),
        ],
        ["decodes to an action result, not a redirect", () => turbo(TURBO_ID, 202)],
      ];
      for (const [label, make] of odd) {
        it(`captureOrQueue queues it when it ${label}`, async () => {
          const store = new MemoryQueueStore();
          const res = await captureOrQueue(
            "/m/tasks/new",
            { title: "t" },
            store,
            fakeFetch([make()]),
          );
          expect(res.state).toBe("queued");
          expect(res.authRequired).toBeUndefined();
          const [entry] = await store.list();
          expect(entry.authRequired).toBeUndefined();
          expect(entry.error).toBeUndefined();
        });

        it(`replay keeps the entry when it ${label}`, async () => {
          const store = new MemoryQueueStore();
          await store.put(mkEntry(ENTRY_ID));
          const summary = await replayQueue(store, fakeFetch([make()]));
          expect(summary).toEqual({ sent: 0, refused: 0, kept: 1 });
          expect(await store.list()).toHaveLength(1);
        });
      }
    });

    it("a single-fetch redirect elsewhere is not a confirmation: the capture stays queued", async () => {
      // Capture actions answer JSON on success, never a redirect, so any other
      // redirect means the create was not confirmed. Replaying is safe (the
      // create is idempotent on clientId).
      const store = new MemoryQueueStore();
      const res = await captureOrQueue(
        "/m/tasks/new",
        { title: "t" },
        store,
        fakeFetch([await singleFetchRedirect("/m/rooms")]),
      );
      expect(res.state).toBe("queued");
      expect(res.authRequired).toBeUndefined();
      const [entry] = await store.list();
      expect(entry.error).toBeUndefined();
      expect(entry.authRequired).toBeUndefined();

      const summary = await replayQueue(store, fakeFetch([await singleFetchRedirect("/m/rooms")]));
      expect(summary).toEqual({ sent: 0, refused: 0, kept: 1 });
      expect(await store.list()).toHaveLength(1);
    });

    it("a followed redirect to another page is not a confirmation either", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry(ENTRY_ID));
      const summary = await replayQueue(store, fakeFetch([followed("http://localhost/m/rooms")]));
      expect(summary).toEqual({ sent: 0, refused: 0, kept: 1 });
      expect(await store.list()).toHaveLength(1);
    });

    it("a genuine 2xx still removes and a 4xx validation refusal still stores its error", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry("ca11111111111111111111111", 1));
      await store.put(mkEntry("cb22222222222222222222222", 2));
      const summary = await replayQueue(
        store,
        fakeFetch([
          json({ id: "ca11111111111111111111111" }),
          json({ error: "Titel ist zu lang." }, 400),
        ]),
      );
      expect(summary).toEqual({ sent: 1, refused: 1, kept: 0 });
      const [entry] = await store.list();
      expect(entry).toMatchObject({
        clientId: "cb22222222222222222222222",
        error: "Titel ist zu lang.",
      });
      expect(entry.authRequired).toBeUndefined();
    });
  });

  describe("change notifications", () => {
    afterEach(() => vi.unstubAllGlobals());

    function countEvents(): () => number {
      const target = new EventTarget();
      vi.stubGlobal("window", target);
      let n = 0;
      target.addEventListener(QUEUE_CHANGED_EVENT, () => (n += 1));
      return () => n;
    }

    it("fires when a pass only sets the sign-in flag, and not when it was already set", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry(ENTRY_ID));
      const events = countEvents();

      await replayQueue(store, fakeFetch([new Response("", { status: 401 })]));
      expect((await store.list())[0]?.authRequired).toBe(true);
      expect(events()).toBe(1);

      await replayQueue(store, fakeFetch([new Response("", { status: 401 })]));
      expect(events()).toBe(1);
    });

    it("fires when a pass clears the sign-in flag", async () => {
      const store = new MemoryQueueStore();
      await store.put({ ...mkEntry(ENTRY_ID), authRequired: true });
      const events = countEvents();
      await replayQueue(store, fakeFetch([json({ error: "Titel ist zu lang." }, 400)]));
      expect((await store.list())[0]?.authRequired).toBeUndefined();
      expect(events()).toBe(1);
    });

    it("fires once for a wall that flags several entries, and not when they are all flagged already", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry("ca11111111111111111111111", 1));
      await store.put(mkEntry("cb22222222222222222222222", 2));
      const events = countEvents();
      await replayQueue(store, fakeFetch([new Response("", { status: 401 })]));
      expect(events()).toBe(1);
      await replayQueue(store, fakeFetch([new Response("", { status: 401 })]));
      expect(events()).toBe(1);
    });

    it("fires when a send clears the flag of an entry that was not itself sent", async () => {
      const store = new MemoryQueueStore();
      await store.put({ ...mkEntry("ca11111111111111111111111", 1), authRequired: true });
      await store.put({ ...mkEntry("cb22222222222222222222222", 2), authRequired: true });
      const events = countEvents();
      await replayQueue(
        store,
        fakeFetch([new Response("", { status: 503 }), json({ id: "cb22222222222222222222222" })]),
      );
      expect(events()).toBe(1);
      expect((await store.list())[0]?.authRequired).toBeUndefined();
    });

    it("stays quiet when nothing in the store changed", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry(ENTRY_ID));
      const events = countEvents();
      await replayQueue(store, fakeFetch([new Response("", { status: 503 })]));
      expect(events()).toBe(0);
    });
  });

  describe("owner binding", () => {
    const ALICE = "cuseralice000000000000001";
    const BOB = "cuserbob00000000000000002";
    const owned = (clientId: string, userId: string | undefined, createdAt = 1): QueuedCapture => ({
      ...mkEntry(clientId, createdAt),
      ...(userId ? { userId } : {}),
    });

    it("captureOrQueue records the signed-in user on the queued entry", async () => {
      const store = new MemoryQueueStore();
      const offline = await captureOrQueue(
        "/m/tasks/new",
        { title: "t" },
        store,
        fakeFetch([new TypeError("offline")]),
        ALICE,
      );
      const wall = await captureOrQueue(
        "/m/tasks/new",
        { title: "u" },
        store,
        fakeFetch([new Response("", { status: 401 })]),
        ALICE,
      );
      const entries = await store.list();
      expect(entries.map((e) => e.clientId).sort()).toEqual(
        [offline.clientId, wall.clientId].sort(),
      );
      expect(entries.every((e) => e.userId === ALICE)).toBe(true);
    });

    it("sends the owner with every POST, on submit and on replay", async () => {
      const store = new MemoryQueueStore();
      const seen: (string | null)[] = [];
      const offline = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get(CAPTURE_OWNER_HEADER));
        throw new TypeError("offline");
      }) as typeof fetch;
      await captureOrQueue("/m/tasks/new", { title: "t" }, store, offline, ALICE);
      await replayQueue(store, offline, ALICE);
      expect(seen).toEqual([ALICE, ALICE]);
    });

    it("sends no owner header for a capture that has none", async () => {
      const seen: (string | null)[] = [];
      const spy = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get(CAPTURE_OWNER_HEADER));
        return json({ id: "cabc12345678901234567890" });
      }) as typeof fetch;
      await captureOrQueue("/m/tasks/new", { title: "t" }, new MemoryQueueStore(), spy);
      expect(seen).toEqual([null]);
    });

    it("a 403 for a foreign owner keeps the entry and flags it, as for an expired session", async () => {
      const store = new MemoryQueueStore();
      await store.put(owned("ca11111111111111111111111", ALICE, 1));
      const summary = await replayQueue(
        store,
        fakeFetch([new Response("Forbidden", { status: 403 })]),
        ALICE,
      );
      expect(summary).toEqual({ sent: 0, refused: 0, kept: 1, authRequired: true });
      const [entry] = await store.list();
      expect(entry).toMatchObject({ userId: ALICE, authRequired: true });
      expect(entry?.error).toBeUndefined();
    });

    it("replays only the current user's entries and leaves the others untouched", async () => {
      const store = new MemoryQueueStore();
      const theirs = owned("cb22222222222222222222222", BOB, 2);
      const theirsFlagged = {
        ...owned("cc33333333333333333333333", BOB, 3),
        authRequired: true,
      };
      await store.put(owned("ca11111111111111111111111", ALICE, 1));
      await store.put(theirs);
      await store.put(theirsFlagged);
      const calls: string[] = [];
      const summary = await replayQueue(
        store,
        fakeFetch([json({ id: "ca11111111111111111111111" })], calls),
        ALICE,
      );
      expect(calls).toHaveLength(1);
      expect(summary).toEqual({ sent: 1, refused: 0, kept: 0 });
      expect(await store.list()).toEqual([theirs, theirsFlagged]);
    });

    it("an entry replays once its owner is the current user", async () => {
      const store = new MemoryQueueStore();
      await store.put(owned("cb22222222222222222222222", BOB));
      const calls: string[] = [];
      expect(await replayQueue(store, fakeFetch([], calls), ALICE)).toEqual({
        sent: 0,
        refused: 0,
        kept: 0,
      });
      expect(calls).toHaveLength(0);
      const summary = await replayQueue(
        store,
        fakeFetch([json({ id: "cb22222222222222222222222" })], calls),
        BOB,
      );
      expect(summary).toEqual({ sent: 1, refused: 0, kept: 0 });
      expect(calls).toHaveLength(1);
      expect(await store.list()).toHaveLength(0);
    });

    it("a wall met by one user's entry does not stop the next user's pass", async () => {
      const store = new MemoryQueueStore();
      await store.put(owned("ca11111111111111111111111", ALICE, 1));
      await store.put(owned("cb22222222222222222222222", BOB, 2));
      const wall = await replayQueue(store, fakeFetch([new Response("", { status: 401 })]), ALICE);
      expect(wall.authRequired).toBe(true);
      const calls: string[] = [];
      const summary = await replayQueue(
        store,
        fakeFetch([json({ id: "cb22222222222222222222222" })], calls),
        BOB,
      );
      expect(summary).toEqual({ sent: 1, refused: 0, kept: 0 });
      expect(calls).toHaveLength(1);
    });

    it("passes for different users never overlap", async () => {
      const store = new MemoryQueueStore();
      await store.put(owned("ca11111111111111111111111", ALICE, 1));
      await store.put(owned("cb22222222222222222222222", BOB, 2));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const order: string[] = [];
      const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const clientId = new URLSearchParams(String(init?.body)).get("clientId") ?? String(input);
        order.push(`start ${clientId}`);
        await gate;
        order.push(`end ${clientId}`);
        return json({ id: clientId });
      }) as typeof fetch;
      const first = replayQueue(store, slowFetch, ALICE);
      const second = replayQueue(store, slowFetch, BOB);
      release();
      await Promise.all([first, second]);
      expect(order).toEqual([
        "start ca11111111111111111111111",
        "end ca11111111111111111111111",
        "start cb22222222222222222222222",
        "end cb22222222222222222222222",
      ]);
      expect(await store.list()).toHaveLength(0);
    });

    it("an entry queued before owners were recorded is adopted by the first user to replay", async () => {
      const store = new MemoryQueueStore();
      await store.put(owned("ca11111111111111111111111", undefined));
      const summary = await replayQueue(store, fakeFetch([new TypeError("offline")]), ALICE);
      expect(summary).toEqual({ sent: 0, refused: 0, kept: 1 });
      expect((await store.list())[0]?.userId).toBe(ALICE);
      // From now on it belongs to her: another user neither sees nor sends it.
      const calls: string[] = [];
      expect(await replayQueue(store, fakeFetch([], calls), BOB)).toEqual({
        sent: 0,
        refused: 0,
        kept: 0,
      });
      expect(calls).toHaveLength(0);
    });

    it("visibleEntries lists, and so counts, only the user's entries plus unowned ones", () => {
      const all = [
        owned("ca11111111111111111111111", ALICE, 1),
        owned("cb22222222222222222222222", BOB, 2),
        owned("cc33333333333333333333333", undefined, 3),
      ];
      expect(visibleEntries(all, ALICE).map((e) => e.clientId)).toEqual([
        "ca11111111111111111111111",
        "cc33333333333333333333333",
      ]);
      expect(visibleEntries(all, BOB).map((e) => e.clientId)).toEqual([
        "cb22222222222222222222222",
        "cc33333333333333333333333",
      ]);
      expect(visibleEntries(all, undefined)).toEqual([]);
    });
  });

  describe("changes made to the store while a pass is running", () => {
    const A = "ca11111111111111111111111";
    const B = "cb22222222222222222222222";

    /**
     * A fetch whose first call waits for `answer`; any further call fails as if
     * offline, so a POST the pass should not make shows up in `sent` instead of
     * hanging the test.
     */
    function gatedFetch() {
      const sent: string[] = [];
      const gates: ((res: Response | Error) => void)[] = [];
      const impl = ((_input: RequestInfo | URL, init?: RequestInit) => {
        sent.push(new URLSearchParams(String(init?.body)).get("clientId") ?? "");
        if (sent.length > 1) return Promise.reject(new TypeError("offline"));
        return new Promise<Response>((resolve, reject) => {
          gates.push((res) => (res instanceof Error ? reject(res) : resolve(res)));
        });
      }) as typeof fetch;
      return { impl, sent, answer: (i: number, res: Response | Error) => gates[i]!(res) };
    }

    /** Wait until the pass has issued the given number of POSTs. */
    async function untilPosted(sent: string[], count: number) {
      await vi.waitFor(() => expect(sent).toHaveLength(count));
    }

    it("an entry discarded while an earlier POST is pending is not sent in the same pass", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry(A, 1));
      await store.put(mkEntry(B, 2));
      const net = gatedFetch();
      const pass = replayQueue(store, net.impl);
      await untilPosted(net.sent, 1);
      await store.remove(B);
      net.answer(0, json({ id: A }));
      await pass;
      expect(net.sent).toEqual([A]);
      expect(await store.list()).toEqual([]);
    });

    it("an entry discarded during a pass that meets the wall stays discarded", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry(A, 1));
      await store.put(mkEntry(B, 2));
      const net = gatedFetch();
      const pass = replayQueue(store, net.impl);
      await untilPosted(net.sent, 1);
      await store.remove(B);
      net.answer(0, new Response("Unauthorized", { status: 401 }));
      expect(await pass).toEqual({ sent: 0, refused: 0, kept: 1, authRequired: true });
      const left = await store.list();
      expect(left.map((e) => e.clientId)).toEqual([A]);
      expect(left[0]?.authRequired).toBe(true);
    });

    it("an entry discarded during a pass that clears the sign-in flag stays discarded", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry(A, 1));
      // Kept for a refusal it carries; the flag on it is stale.
      await store.put({ ...mkEntry(B, 2), error: "Titel ist zu lang.", authRequired: true });
      const net = gatedFetch();
      const pass = replayQueue(store, net.impl);
      await untilPosted(net.sent, 1);
      await store.remove(B);
      net.answer(0, json({ id: A }));
      await pass;
      expect(await store.list()).toEqual([]);
    });

    it("the flag write keeps what another tab stored in the meantime", async () => {
      const store = new MemoryQueueStore();
      await store.put(mkEntry(A, 1));
      await store.put(mkEntry(B, 2));
      const net = gatedFetch();
      const pass = replayQueue(store, net.impl);
      await untilPosted(net.sent, 1);
      // Another tab refused B while this pass was waiting on A.
      await store.put({ ...mkEntry(B, 2), fields: { title: "edited" }, error: "Nope." });
      net.answer(0, new Response("Unauthorized", { status: 401 }));
      await pass;
      const b = (await store.list()).find((e) => e.clientId === B);
      expect(b).toMatchObject({ fields: { title: "edited" }, error: "Nope." });
      expect(b?.authRequired).toBeUndefined();
    });
  });
});
