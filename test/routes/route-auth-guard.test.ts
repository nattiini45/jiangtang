import { describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

/**
 * Standing guard: every route module that exports a `loader` or an `action` must turn an
 * anonymous request away itself, unless it is on the explicit PUBLIC list below.
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
 * The only accepted outcome is a rejection before any data is read: a thrown (or returned)
 * redirect to `/login`. Any other throw, such as a database error, does not count, because that
 * would mean the handler got as far as reading data.
 */

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
  "routes/calendar.$token.ics":
    "calendar clients subscribe without cookies; the feed token gates it",
  "routes/healthz": "liveness probe for the load balancer; returns no application data",
  "routes/prefs.locale": "sets the language cookie, also for signed-out visitors",
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

const callAnonymously = async (handler: Handler, kind: "loader" | "action"): Promise<Outcome> => {
  const request = new Request("http://localhost/anonymous-probe", {
    method: kind === "action" ? "POST" : "GET",
    ...(kind === "action" ? { body: new URLSearchParams({ probe: "1" }) } : {}),
  });
  try {
    return classify(await handler({ request, params: fakeParams(), context: {} }));
  } catch (thrown) {
    return classify(thrown);
  }
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
        const outcome = await callAnonymously(handler, kind);
        if (outcome.kind !== "redirect-to-login") {
          failures.push(`${kind}: expected a redirect to /login, got ${outcome.detail}`);
        }
      }
      expect(failures, failures.join("; ")).toEqual([]);
    },
  );
});
