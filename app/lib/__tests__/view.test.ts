import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequestHandler, matchRoutes, type ServerBuild } from "react-router";
import {
  authLanding,
  DESKTOP_PAGES,
  explicitView,
  hasMobileEquivalent,
  MOBILE_PAGES,
  preferredView,
  setViewCookie,
  viewMiddleware,
  viewPath,
  viewRedirect,
} from "~/lib/view.server";

(globalThis as { __reactRouterAppDirectory?: string }).__reactRouterAppDirectory = fileURLToPath(
  new URL("../../", import.meta.url),
);
const { flatRoutes } = await import("@react-router/fs-routes");
type Entry = { id: string; path?: string; index?: boolean; children?: Entry[] };
const routes = (await flatRoutes()) as Entry[];

function pages(entries: Entry[], prefix = ""): { id: string; path: string }[] {
  return entries.flatMap((entry) => {
    const path = [prefix, entry.path].filter(Boolean).join("/");
    return [
      ...(entry.index || !entry.children?.length ? [{ id: entry.id, path: `/${path}` }] : []),
      ...pages(entry.children ?? [], path),
    ];
  });
}

const phone = {
  "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148",
};
const request = (path: string, headers: HeadersInit = phone, method = "GET") =>
  new Request(`http://localhost${path}`, { headers, method });
afterEach(() => vi.unstubAllEnvs());

describe("phone and explicit view selection", () => {
  it.each([
    [phone, "mobile"],
    [
      { "user-agent": "Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit Chrome Mobile Safari" },
      "mobile",
    ],
    [{ "user-agent": "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Mobile/15E148" }, "desktop"],
    [
      { "user-agent": "Mozilla/5.0 (Linux; Android 15; Tablet) AppleWebKit Chrome Safari" },
      "desktop",
    ],
    [{ "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)" }, "desktop"],
    [{ ...phone, "sec-ch-ua-mobile": "?0" }, "desktop"],
    [{ "sec-ch-ua-mobile": "?1" }, "mobile"],
    [{ ...phone, "sec-ch-ua-mobile": "invalid" }, "mobile"],
    [{ ...phone, cookie: "view=desktop", "sec-ch-ua-mobile": "?1" }, "desktop"],
    [{ cookie: "view=mobile", "sec-ch-ua-mobile": "?0" }, "mobile"],
    [{}, "desktop"],
  ] as const)("selects %s as %s", (headers, expected) => {
    expect(preferredView(new Headers(headers))).toBe(expected);
  });

  it("accepts only exact cookie enum values and survives other cookies", () => {
    expect(explicitView(new Headers({ cookie: "locale=de; view=desktop; theme=dark" }))).toBe(
      "desktop",
    );
    for (const cookie of [
      "view=desktopX",
      "preview=mobile",
      "view=Mobile",
      "view=%6dobile",
      "view=",
    ]) {
      expect(explicitView(new Headers({ cookie }))).toBeUndefined();
    }
  });

  it("persists a private, host-only one-year preference with production TLS", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(setViewCookie("desktop")).toBe(
      "view=desktop; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure",
    );
    vi.stubEnv("NODE_ENV", "development");
    expect(setViewCookie("mobile")).not.toContain("Secure");
  });
});

const equivalents = [
  ["/", "/m"],
  ["/quick-entry", "/m"],
  ["/tickets/new", "/m"],
  ["/board", "/m/board"],
  ["/events", "/m/events"],
  ["/events/new", "/m/events/new"],
  ["/inventory/stock", "/m/inventory/stock"],
  ["/inventory/equipment-1", "/m?equipmentId=equipment-1"],
  ["/inventory/stock/item-1", "/m/inventory/stock/item-1"],
  ["/locations", "/m/locations"],
  ["/notes", "/m/notes"],
  ["/notes/new", "/m/notes/new"],
  ["/notifications", "/m/notifications"],
  ["/projects", "/m/projects"],
  ["/rooms", "/m/rooms"],
  ["/rooms/hall-a", "/m/rooms/hall-a"],
  ["/search", "/m/search"],
  ["/tasks", "/m/tasks?all=1"],
  ["/tasks/new", "/m/tasks/new"],
  ["/tasks/task-1", "/m/tasks/task-1"],
  ["/tickets", "/m/tickets"],
  ["/tickets/ticket-1", "/m/tickets/ticket-1"],
  ["/timesheet", "/m/timesheet"],
] as const;

describe("route equivalents", () => {
  it("keeps equipment detail search hits as desktop handoffs despite the QR capture shortcut", () => {
    expect(hasMobileEquivalent("/inventory/projector-1")).toBe(false);
    expect(hasMobileEquivalent("/inventory/stock/item-1")).toBe(true);
    expect(hasMobileEquivalent("/tasks/task-1")).toBe(true);
  });
  it("classifies every real desktop page and only real pages", () => {
    expect([...DESKTOP_PAGES].sort()).toEqual(
      pages(routes)
        .filter((entry) => entry.id.startsWith("routes/_desktop."))
        .map((entry) => entry.path)
        .sort(),
    );
  });

  it("targets every real mobile page, without inventing detail screens", () => {
    expect([...MOBILE_PAGES].sort()).toEqual(
      pages(routes)
        .filter((entry) => entry.id.startsWith("routes/m."))
        .map((entry) => entry.path)
        .sort(),
    );
  });

  it.each(equivalents)("maps %s to its actual equivalent %s", (desktop, mobile) => {
    expect(viewPath(desktop, "mobile")).toBe(mobile);
    const matches = matchRoutes(routes as never, mobile);
    expect(matches?.at(-1)?.route.id).toMatch(/^routes\/m\./);
  });

  it("falls back to capture for every remaining desktop-only page", () => {
    const supported = new Set(
      equivalents.map(
        ([desktop]) =>
          matchRoutes(
            DESKTOP_PAGES.map((path) => ({ path })),
            desktop,
          )?.at(-1)?.route.path,
      ),
    );
    for (const page of DESKTOP_PAGES) {
      const concrete = page.replace(/:id/g, "item-1").replace(/:slug/g, "hall-a");
      const equivalent = viewPath(concrete, "mobile");
      if (!supported.has(page)) {
        expect(equivalent, page).toBe("/m");
      }
    }
  });

  it.each([
    ["/events?date=2026-11-09&view=rooms&room=a", "/m/events?date=2026-11-09"],
    [
      "/events/new?date=2026-11-09&startsAt=2026-11-09T08%3A00Z&endsAt=2026-11-09T09%3A00Z&roomId=a",
      "/m/events/new?date=2026-11-09&startsAt=2026-11-09T08%3A00Z&endsAt=2026-11-09T09%3A00Z&roomId=a",
    ],
    ["/search?q=room+one&limit=10", "/m/search?q=room+one"],
    ["/tickets?status=OPEN&q=screen&assignee=me", "/m/tickets?q=screen&status=OPEN"],
    [
      "/inventory/stock?q=lamp&hideUnassigned=1&sort=sku",
      "/m/inventory/stock?q=lamp&hideUnassigned=1",
    ],
    ["/timesheet?week=2026-11-09", "/m/timesheet?week=2026-11-09"],
    ["/tasks?assignee=me&project=hall", "/m/tasks"],
    [
      "/quick-entry?roomId=a&equipmentId=b&type=INCIDENT",
      "/m?roomId=a&equipmentId=b&type=INCIDENT",
    ],
    ["/tickets/new?roomId=a&equipmentId=b", "/m?roomId=a&equipmentId=b"],
    ["/inventory/projector-1?equipmentId=forged", "/m?equipmentId=projector-1"],
    ["/inventory/a%20b", "/m?equipmentId=a+b"],
    ["/rooms/a%20b#bookings", "/m/rooms/a%20b#bookings"],
    ["/tasks/a%3Fb%23c", "/m/tasks/a%3Fb%23c"],
    ["/tasks.data?_routes=routes%2F_desktop.tasks._index&assignee=me", "/m/tasks"],
    ["/_root.data?_routes=root", "/m"],
  ])("preserves supported query/context from %s", (source, expected) =>
    expect(viewPath(source, "mobile")).toBe(expected),
  );

  it("maps the explicit desktop switch back to real routes", () => {
    expect(viewPath("/m/tasks/t-1", "desktop")).toBe("/tasks/t-1");
    expect(viewPath("/m/tasks", "desktop")).toBe("/tasks?assignee=me");
    expect(viewPath("/m/tasks?all=1", "desktop")).toBe("/tasks");
    expect(viewPath("/m?roomId=a", "desktop")).toBe("/quick-entry?roomId=a");
    expect(viewPath("/m/offline", "desktop")).toBe("/");
    expect(viewPath("/notes/n-1?version=2", "desktop")).toBe("/notes/n-1?version=2");
  });

  it.each([
    "//evil.test",
    "https://evil.test",
    "/\\evil.test",
    "/\t/evil.test",
    "/a/..//evil.test",
    "/a/../\\evil.test",
  ])("never turns %s into an external redirect", (raw) => {
    expect(authLanding(request("/login"), raw)).toBe("/m");
    expect(authLanding(request("/login", { cookie: "view=desktop" }), raw)).toBe("/");
  });
});

describe("routing boundaries", () => {
  it.each([
    ["/rooms.data?_routes=routes%2F_desktop.rooms._index", "/m/rooms"],
    ["/_root.data?_routes=root", "/m"],
    ["/tasks.data?assignee=me", "/m/tasks"],
  ])("normalizes raw single-fetch request %s before matching", (path, target) => {
    expect(viewRedirect(request(path))).toBe(target);
  });

  it.each([
    "/api/auth/get-session",
    "/api/search",
    "/api/ask",
    "/api/realtime",
    "/api/events/check-conflict",
    "/attachments/upload",
    "/attachments/key",
    "/notes/n-1/export",
    "/export/workspace.json",
    "/calendar/token.ics",
    "/prefs/locale",
    "/prefs/view",
    "/healthz",
    "/login",
    "/login/two-factor",
    "/accept-invite/token",
    "/reset-password/token",
    "/welcome",
    "/assets/app.js",
    "/sw.js",
    "/manifest.webmanifest",
    "/icon-192.png",
    "/not-a-page",
  ])("never reroutes resource/public URL %s", (path) =>
    expect(viewRedirect(request(path))).toBeNull(),
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD"])(
    "never reroutes %s or changes an action result",
    (method) => expect(viewRedirect(request("/tasks/t-1", phone, method))).toBeNull(),
  );

  it("keeps explicit /m access and mandatory admin enrolment reachable", () => {
    expect(viewRedirect(request("/m/tasks", {}))).toBeNull();
    expect(viewRedirect(request("/account?twoFactor=required"))).toBeNull();
    expect(viewRedirect(request("/rooms/hall", { ...phone, cookie: "view=desktop" }))).toBeNull();
    expect(viewRedirect(request("/m/rooms/hall", { cookie: "view=desktop" }))).toBe("/rooms/hall");
    expect(viewRedirect(request("/rooms/hall", { cookie: "view=mobile" }))).toBe("/m/rooms/hall");
  });
});

describe("React Router middleware and single-fetch", () => {
  it("keeps private page responses URL-cacheable offline without routing Vary headers", async () => {
    const next = vi.fn(async () => new Response("mobile page"));
    const response = await viewMiddleware({ request: request("/m/tasks") } as never, next as never);
    if (!response) throw new Error("Expected a page response");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBeNull();
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not change a resource response's cache policy or variation", async () => {
    const next = async () =>
      new Response("resource", {
        headers: { "Cache-Control": "private, max-age=60", Vary: "Accept" },
      });
    const response = await viewMiddleware(
      { request: request("/api/search?q=room") } as never,
      next as never,
    );
    if (!response) throw new Error("Expected a resource response");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=60");
    expect(response.headers.get("Vary")).toBe("Accept");
  });

  function handler() {
    const loader = vi.fn(() => ({ privateTitle: "must never be sent before auth" }));
    const action = vi.fn(() => ({ validationError: "unchanged action result" }));
    const handle = createRequestHandler(
      {
        ssr: true,
        routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
        future: { v8_middleware: true },
        routes: {
          root: {
            id: "root",
            path: "",
            module: { middleware: [viewMiddleware], default: () => null },
          },
          tasks: {
            id: "tasks",
            parentId: "root",
            path: "tasks",
            module: { loader, action, default: () => null },
          },
        },
        assets: {
          routes: {
            root: { id: "root" },
            tasks: {
              id: "tasks",
              parentId: "root",
              path: "tasks",
              hasLoader: true,
              hasAction: true,
            },
          },
        },
        entry: { module: { default: () => new Response("document") } },
      } as unknown as ServerBuild,
      "test",
    );
    return { handle, loader, action };
  }

  it("uses framework single-fetch redirects before any selected child loader", async () => {
    const { handle, loader } = handler();
    const response = await handle(request("/tasks.data?_routes=tasks"));
    expect(response.status).toBe(202);
    expect(response.headers.get("Content-Type")).toContain("text/x-script");
    const body = await response.text();
    expect(body).toContain("/m/tasks?all=1");
    expect(body).not.toContain("privateTitle");
    expect(loader).not.toHaveBeenCalled();
  });

  it("returns a normal document redirect without invoking loaders", async () => {
    const { handle, loader } = handler();
    const response = await handle(request("/tasks"));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/m/tasks?all=1");
    expect(response.headers.get("Vary")).toContain("Sec-CH-UA-Mobile");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(loader).not.toHaveBeenCalled();
  });

  it("lets single-fetch POST execute and serialize its original action response", async () => {
    const { handle, action } = handler();
    const response = await handle(request("/tasks.data", phone, "POST"));
    expect(response.status).toBe(200);
    expect(response.headers.has("Location")).toBe(false);
    expect(await response.text()).toContain("unchanged action result");
    expect(action).toHaveBeenCalledOnce();
  });
});
