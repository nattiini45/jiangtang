import { describe, expect, it, vi } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/**
 * Standing guard: every route module that exports a `loader` or an `action` must turn an
 * anonymous request away itself, before it touches the database, unless it is on the explicit
 * PUBLIC list below.
 *
 * Why the layout's check is not enough: React Router single-fetch (`<path>.data`) honours
 * `?_routes=<route ids>` and then runs only the loaders of the routes named there. A signed-out
 * `GET /rooms.data?_routes=routes/_desktop.rooms._index` therefore runs the child loader and
 * returns its data without the `_desktop` layout loader (and its `requireUser`) ever running.
 * Actions are reachable on their own as well. So each route has to carry its own check.
 *
 * The test is behavioural. It enumerates the real route table with `flatRoutes()` (the same way
 * `route-resolution.test.ts` does), imports every route module, and calls each exported loader
 * and action with an anonymous request: no cookie, `GET` for loaders and `POST` for actions.
 * Two things must hold for every handler:
 *
 * 1. It rejects with a redirect to `/login`, thrown or returned.
 * 2. It never reaches the database on the way there. `~/lib/db.server` is replaced by a client
 *    that records and refuses any access while a handler runs, so a handler that reads or writes
 *    first and calls `requireUser` afterwards fails even though it ends in the same redirect.
 *
 * The real `~/lib/auth.server` stays in place, so each handler meets the real `requireUser`
 * or `requireRole`, which must answer an anonymous request without touching the database
 * either. Out of scope: other data stores a handler could read before its check, namely object
 * storage on disk and the AI endpoints; only the database is observed.
 */

/**
 * A stand-in for the shared Prisma client. While `armed` it records every property read
 * (`db.room`, `db.$transaction`, ...) and throws, so the first data access of a handler is both
 * visible to the test and fatal to the handler. While disarmed, which covers loading the route
 * modules, it answers `undefined`: import-time code must not need a database.
 */
const dbProbe = vi.hoisted(() => {
  const state = { armed: false, accesses: [] as string[] };
  const client = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (!state.armed || typeof key !== "string") return undefined;
        state.accesses.push(`db.${key}`);
        throw new Error(`database access (db.${key}) before the sign-in check`);
      },
    },
  );
  return { state, client };
});

vi.mock("~/lib/db.server", () => ({ db: dbProbe.client }));

type AppDirectoryGlobal = { __reactRouterAppDirectory?: string };
const APP_DIR = fileURLToPath(new URL("../../app", import.meta.url));
(globalThis as AppDirectoryGlobal).__reactRouterAppDirectory = APP_DIR;

const { flatRoutes } = await import("@react-router/fs-routes");

type RouteEntry = { id?: string; file?: string; children?: RouteEntry[] };

const flatten = (entries: RouteEntry[]): RouteEntry[] =>
  entries.flatMap((entry) => [entry, ...(entry.children ? flatten(entry.children) : [])]);

const ROUTES = flatten((await flatRoutes()) as RouteEntry[]).filter(
  (entry): entry is Required<Pick<RouteEntry, "id" | "file">> => Boolean(entry.id && entry.file),
);

/**
 * Routes that are public on purpose. Keep this list short and give every entry its reason;
 * adding a route here is a decision about who may read or write, not a way to silence the test.
 */
const PUBLIC: Record<string, string> = {
  "routes/login": "the sign-in form and its action",
  "routes/logout": "ends the session; harmless without one",
  "routes/accept-invite.$token": "invitees have no account yet; the invite token gates it",
  "routes/reset-password.$token":
    "the person cannot sign in yet; the one-time reset token gates it",
  "routes/calendar.$token.ics":
    "calendar clients subscribe without cookies; the feed token gates it",
  "routes/healthz": "liveness probe for the load balancer; returns no application data",
  "routes/prefs.locale": "sets the language cookie, also for signed-out visitors",
  "routes/welcome":
    "public landing page; its loader redirects signed-in users to / and reads nothing private",
  "routes/$": "catch-all that answers 404 to everyone and reads nothing",
};

type Handler = (args: {
  request: Request;
  params: Record<string, string>;
  context: Record<string, never>;
}) => unknown;

type RouteModule = { loader?: Handler; action?: Handler };

const load = async (file: string): Promise<RouteModule> =>
  (await import(/* @vite-ignore */ pathToFileURL(path.join(APP_DIR, file)).href)) as RouteModule;

/** Plausible params for any `:segment`: the guard has to fire before the value is looked at. */
const fakeParams = (): Record<string, string> =>
  new Proxy({} as Record<string, string>, {
    get: (_, key) => (typeof key === "string" ? "x" : undefined),
  });

type Outcome = { kind: "redirect-to-login" } | { kind: "other"; detail: string };

const classify = (value: unknown): Outcome => {
  if (value instanceof Response) {
    const location = value.headers.get("Location") ?? "";
    if (value.status >= 300 && value.status < 400 && location.startsWith("/login")) {
      return { kind: "redirect-to-login" };
    }
    return { kind: "other", detail: `Response ${value.status} ${location}`.trim() };
  }
  if (value instanceof Error)
    return { kind: "other", detail: `threw ${value.name}: ${value.message}` };
  return { kind: "other", detail: "returned data" };
};

type Probe = { outcome: Outcome; databaseAccesses: string[] };

const callAnonymously = async (handler: Handler, kind: "loader" | "action"): Promise<Probe> => {
  const request = new Request("http://localhost/anonymous-probe", {
    method: kind === "action" ? "POST" : "GET",
    ...(kind === "action" ? { body: new URLSearchParams({ probe: "1" }) } : {}),
  });
  dbProbe.state.accesses = [];
  dbProbe.state.armed = true;
  let outcome: Outcome;
  try {
    outcome = classify(await handler({ request, params: fakeParams(), context: {} }));
  } catch (thrown) {
    outcome = classify(thrown);
  } finally {
    dbProbe.state.armed = false;
  }
  return { outcome, databaseAccesses: [...dbProbe.state.accesses] };
};

/**
 * The verdict for one handler: an empty list when it turned the anonymous request away before
 * touching the database, otherwise one message per way it failed to. Database access is judged
 * first because a handler that read before its check is wrong even when it still ends in the
 * right redirect.
 */
const judge = (kind: "loader" | "action", probe: Probe): string[] => {
  if (probe.databaseAccesses.length > 0) {
    return [
      `${kind}: reached the database before turning the request away (${probe.databaseAccesses.join(", ")})`,
    ];
  }
  if (probe.outcome.kind !== "redirect-to-login") {
    return [`${kind}: expected a redirect to /login, got ${probe.outcome.detail}`];
  }
  return [];
};

describe("route auth guard — the route table", () => {
  it("sees the real route table", () => {
    // Control for the control: an empty walk would make every check below pass vacuously.
    expect(ROUTES.length).toBeGreaterThan(50);
  });

  it("every PUBLIC entry names a route that still exists and still exports a handler", async () => {
    const byId = new Map(ROUTES.map((r) => [r.id, r]));
    const stale = Object.keys(PUBLIC).filter((id) => !byId.has(id));
    expect(stale, `PUBLIC names routes that are gone: ${stale.join(", ") || "none"}`).toEqual([]);

    const handlerless: string[] = [];
    for (const id of Object.keys(PUBLIC)) {
      const mod = await load(byId.get(id)!.file);
      if (!mod.loader && !mod.action) handlerless.push(id);
    }
    // An allowlist entry for a route without a loader or action excuses nothing.
    expect(
      handlerless,
      `PUBLIC entries without a loader or action: ${handlerless.join(", ")}`,
    ).toEqual([]);
  });
});

describe("route auth guard — the probe itself", () => {
  const anonymous = (url = "http://localhost/rooms?campus=a b") => new Request(url);

  it("the real requireUser sends an anonymous request to /login and keeps the way back", async () => {
    const { requireUser } = await import("~/lib/auth.server");
    dbProbe.state.accesses = [];
    dbProbe.state.armed = true;
    let thrown: unknown;
    try {
      await requireUser(anonymous());
    } catch (error) {
      thrown = error;
    } finally {
      dbProbe.state.armed = false;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe(
      `/login?next=${encodeURIComponent("/rooms?campus=a%20b")}`,
    );
    expect(dbProbe.state.accesses).toEqual([]);
  });

  it("the real requireRole and getOptionalUser treat an anonymous request the same way", async () => {
    const { requireRole, getOptionalUser } = await import("~/lib/auth.server");
    dbProbe.state.accesses = [];
    dbProbe.state.armed = true;
    try {
      await expect(requireRole(anonymous(), "ADMIN")).rejects.toMatchObject({ status: 302 });
      await expect(getOptionalUser(anonymous())).resolves.toBeNull();
    } finally {
      dbProbe.state.armed = false;
    }
    expect(dbProbe.state.accesses).toEqual([]);
  });

  it("flags a handler that reads before its check, even when the read ends in a redirect", async () => {
    const { requireUser } = await import("~/lib/auth.server");
    const { db } = await import("~/lib/db.server");
    const readsFirst: Handler = async ({ request }) => {
      try {
        await (db as unknown as { room: { findMany: () => Promise<unknown> } }).room.findMany();
      } catch {
        // A handler that swallows the failure must not hide the access.
      }
      await requireUser(request);
      return null;
    };
    const probe = await callAnonymously(readsFirst, "loader");
    expect(probe.outcome.kind).toBe("redirect-to-login");
    expect(probe.databaseAccesses).toEqual(["db.room"]);
  });

  it("the probe is wired to the client the real auth module uses", async () => {
    // The anonymous checks above record nothing because Better Auth answers a request without
    // a session cookie before it reads anything. A zero there would look the same if
    // auth.server stopped using the mocked client. A cookie with a valid signature for a token
    // nobody issued gets past that early exit and makes the real getOptionalUser look the
    // session up, so the probe has to see the read.
    const { auth, getOptionalUser } = await import("~/lib/auth.server");
    const context = await auth.$context;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(context.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const token = "unknown-session-token";
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
    const signed = encodeURIComponent(`${token}.${Buffer.from(mac).toString("base64")}`);
    const request = new Request("http://localhost/rooms", {
      headers: { cookie: `${context.authCookies.sessionToken.name}=${signed}` },
    });

    dbProbe.state.accesses = [];
    dbProbe.state.armed = true;
    try {
      // The probe refuses the read, so the lookup itself fails; only the recorded access counts.
      await getOptionalUser(request).catch(() => undefined);
    } finally {
      dbProbe.state.armed = false;
    }
    expect(dbProbe.state.accesses).toContain("db.session");
  });

  it("judges a handler that reads first and then redirects as a failure naming the access", async () => {
    const { requireUser } = await import("~/lib/auth.server");
    const { db } = await import("~/lib/db.server");
    const readsThenRedirects: Handler = async ({ request }) => {
      try {
        await (db as unknown as { room: { findMany: () => Promise<unknown> } }).room.findMany();
      } catch {
        // Swallowed on purpose: the access must still be reported.
      }
      await requireUser(request);
      return null;
    };
    const probe = await callAnonymously(readsThenRedirects, "loader");
    expect(probe.outcome.kind).toBe("redirect-to-login");
    const failures = judge("loader", probe);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("reached the database");
    expect(failures[0]).toContain("db.room");
  });

  it("judges a handler that returns data as a failure", async () => {
    const returnsData: Handler = async () => ({ rooms: [] });
    const failures = judge("loader", await callAnonymously(returnsData, "loader"));
    expect(failures).toEqual(["loader: expected a redirect to /login, got returned data"]);
  });

  it("judges a handler that redirects first as a pass", async () => {
    const { requireUser } = await import("~/lib/auth.server");
    const redirectsFirst: Handler = async ({ request }) => {
      await requireUser(request);
      return null;
    };
    expect(judge("action", await callAnonymously(redirectsFirst, "action"))).toEqual([]);
  });

  it("accepts a handler that checks first", async () => {
    const { requireUser } = await import("~/lib/auth.server");
    const checksFirst: Handler = async ({ request }) => {
      await requireUser(request);
      return null;
    };
    const probe = await callAnonymously(checksFirst, "action");
    expect(probe.outcome.kind).toBe("redirect-to-login");
    expect(probe.databaseAccesses).toEqual([]);
  });
});

describe("route auth guard — anonymous requests are turned away", () => {
  const protectedRoutes = ROUTES.filter((r) => !(r.id in PUBLIC));

  it("covers every route outside the PUBLIC list", () => {
    expect(protectedRoutes.length).toBeGreaterThan(50);
  });

  it.each(protectedRoutes.map((r) => [r.id, r.file] as const))(
    "%s rejects an anonymous request",
    async (_id, file) => {
      const mod = await load(file);
      const calls: Array<["loader" | "action", Handler]> = [];
      if (typeof mod.loader === "function") calls.push(["loader", mod.loader]);
      if (typeof mod.action === "function") calls.push(["action", mod.action]);

      const failures: string[] = [];
      for (const [kind, handler] of calls) {
        failures.push(...judge(kind, await callAnonymously(handler, kind)));
      }
      expect(failures, failures.join("; ")).toEqual([]);
    },
  );
});
