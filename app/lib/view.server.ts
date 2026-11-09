import { generatePath, matchRoutes, redirect, type MiddlewareFunction } from "react-router";
import { sanitizeNext } from "~/lib/auth.server";

export type View = "desktop" | "mobile";

export const DESKTOP_PAGES = [
  "/",
  "/account",
  "/activity",
  "/admin/index",
  "/admin/users",
  "/admin/users/new",
  "/admin/users/:id",
  "/admin/users/:id/erase",
  "/admin/users/:id/reset-password",
  "/analytics",
  "/board",
  "/campuses",
  "/capacity",
  "/events",
  "/events/new",
  "/events/:id",
  "/frequencies",
  "/import",
  "/inventory",
  "/inventory/new",
  "/inventory/import",
  "/inventory/:id",
  "/inventory/models",
  "/inventory/models/new",
  "/inventory/models/:id",
  "/inventory/stock",
  "/inventory/stock/new",
  "/inventory/stock/import",
  "/inventory/stock/:id",
  "/locations",
  "/locations/new",
  "/locations/:id",
  "/locations/:id/edit",
  "/notes",
  "/notes/new",
  "/notes/import",
  "/notes/:id",
  "/notifications",
  "/projects",
  "/projects/new",
  "/projects/:slug",
  "/projects/:slug/edit",
  "/quick-entry",
  "/rooms",
  "/rooms/new",
  "/rooms/import",
  "/rooms/:slug",
  "/rooms/:slug/edit",
  "/rooms/:slug/clone",
  "/search",
  "/tasks",
  "/tasks/new",
  "/tasks/import",
  "/tasks/:id",
  "/tickets",
  "/tickets/new",
  "/tickets/:id",
  "/timesheet",
] as const;

const EQUIVALENTS: Record<string, { mobile: string; query?: string[] }> = {
  "/": { mobile: "/m" },
  "/quick-entry": { mobile: "/m", query: ["roomId", "equipmentId", "type"] },
  "/tickets/new": { mobile: "/m", query: ["roomId", "equipmentId", "type"] },
  "/board": { mobile: "/m/board" },
  "/events": { mobile: "/m/events", query: ["date"] },
  "/events/new": { mobile: "/m/events/new", query: ["date", "startsAt", "endsAt", "roomId"] },
  "/inventory/:id": { mobile: "/m" },
  "/inventory/stock": { mobile: "/m/inventory/stock", query: ["q", "hideUnassigned"] },
  "/inventory/stock/:id": { mobile: "/m/inventory/stock/:id" },
  "/locations": { mobile: "/m/locations" },
  "/notes": { mobile: "/m/notes" },
  "/notes/new": { mobile: "/m/notes/new" },
  "/notifications": { mobile: "/m/notifications" },
  "/projects": { mobile: "/m/projects" },
  "/rooms": { mobile: "/m/rooms" },
  "/rooms/:slug": { mobile: "/m/rooms/:slug" },
  "/search": { mobile: "/m/search", query: ["q"] },
  "/tasks": { mobile: "/m/tasks", query: ["all"] },
  "/tasks/new": { mobile: "/m/tasks/new" },
  "/tasks/:id": { mobile: "/m/tasks/:id" },
  "/tickets": { mobile: "/m/tickets", query: ["q", "status"] },
  "/tickets/:id": { mobile: "/m/tickets/:id" },
  "/timesheet": { mobile: "/m/timesheet", query: ["week"] },
};

export const MOBILE_PAGES = [
  ...new Set(Object.values(EQUIVALENTS).map(({ mobile }) => mobile)),
  "/m/offline",
];

function matchPage(patterns: readonly string[], pathname: string) {
  return matchRoutes(
    patterns.map((path) => ({ path })),
    pathname,
  )?.at(-1);
}

export function explicitView(headers: Headers): View | undefined {
  const value = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("view="))
    ?.slice(5);
  return value === "desktop" || value === "mobile" ? value : undefined;
}

export function preferredView(headers: Headers): View {
  const override = explicitView(headers);
  if (override) return override;
  const hint = headers.get("sec-ch-ua-mobile");
  if (hint === "?1") return "mobile";
  if (hint === "?0") return "desktop";
  const ua = headers.get("user-agent") ?? "";
  if (/iPad|Tablet|Silk|Kindle|PlayBook/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)))
    return "desktop";
  return /iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry|BB10|Opera Mini/i.test(ua)
    ? "mobile"
    : "desktop";
}

export function setViewCookie(view: View): string {
  return `view=${view}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function hasMobileEquivalent(path: string): boolean {
  const match = matchPage(DESKTOP_PAGES, new URL(path, "http://internal.invalid").pathname);
  return Boolean(match && match.route.path !== "/inventory/:id" && EQUIVALENTS[match.route.path!]);
}

export function viewPath(raw: string | null | undefined, view: View): string {
  const url = new URL(sanitizeNext(raw), "http://internal.invalid");
  if (sanitizeNext(url.pathname) === "/" && url.pathname !== "/")
    return view === "mobile" ? "/m" : "/";
  if (url.pathname.endsWith(".data"))
    url.pathname = url.pathname === "/_root.data" ? "/" : url.pathname.slice(0, -5);
  url.searchParams.delete("_routes");
  url.searchParams.delete("index");
  const desktop = matchPage(DESKTOP_PAGES, url.pathname);
  const mobile = matchPage(MOBILE_PAGES, url.pathname);
  if (view === "desktop" && !mobile) return url.pathname + url.search + url.hash;
  if (view === "mobile" && mobile) return url.pathname + url.search + url.hash;
  let target: string | undefined;
  let query: string[] | undefined;
  if (view === "mobile" && desktop) {
    const equivalent = EQUIVALENTS[desktop.route.path!];
    target = equivalent && generatePath(equivalent.mobile, desktop.params);
    query = equivalent?.query;
  } else if (view === "desktop" && mobile) {
    const equivalent = Object.entries(EQUIVALENTS).find(
      ([path, value]) =>
        path !== "/" && path !== "/tickets/new" && value.mobile === mobile.route.path,
    );
    target = equivalent && generatePath(equivalent[0], mobile.params);
    query = equivalent?.[1].query;
  }
  if (!target) return view === "mobile" ? "/m" : "/";
  const search = new URLSearchParams();
  for (const key of query ?? [])
    for (const value of url.searchParams.getAll(key)) search.append(key, value);
  if (view === "mobile" && desktop?.route.path === "/inventory/:id") {
    search.set("equipmentId", desktop.params.id!);
  }
  if (view === "mobile" && desktop?.route.path === "/tasks") {
    if (url.searchParams.get("assignee") === "me") search.delete("all");
    else search.set("all", "1");
  }
  if (view === "desktop" && mobile?.route.path === "/m/tasks") {
    search.delete("all");
    if (url.searchParams.get("all") !== "1") search.set("assignee", "me");
  }
  return target + (search.size ? `?${search}` : "") + url.hash;
}

export function authLanding(request: Request, next?: string | null): string {
  if (
    !explicitView(request.headers) &&
    matchPage(MOBILE_PAGES, new URL(sanitizeNext(next), "http://internal.invalid").pathname)
  ) {
    return viewPath(next, "mobile");
  }
  return viewPath(next, preferredView(request.headers));
}

export function viewRedirect(request: Request): string | null {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (url.pathname === "/account" && url.searchParams.get("twoFactor") === "required") return null;
  const desktop = matchPage(DESKTOP_PAGES, url.pathname);
  const mobile = matchPage(MOBILE_PAGES, url.pathname);
  if (!desktop && !mobile) return null;
  const view = preferredView(request.headers);
  if ((desktop && view === "mobile") || (mobile && explicitView(request.headers) === "desktop")) {
    return viewPath(url.pathname + url.search, view);
  }
  return null;
}

export const viewMiddleware: MiddlewareFunction<Response> = async ({ request }, next) => {
  const target = viewRedirect(request);
  const response = target ? redirect(target) : await next();
  response.headers.set("Accept-CH", "Sec-CH-UA-Mobile");
  response.headers.append("Vary", "Cookie, Sec-CH-UA-Mobile, User-Agent");
  if (target) response.headers.set("Cache-Control", "private, no-store");
  return response;
};
