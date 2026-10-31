import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  StaticRouterProvider,
  createStaticHandler,
  createStaticRouter,
  useRouteError,
  type RouteObject,
} from "react-router";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as root from "~/root";
import * as splat from "~/routes/$";

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Meta: () => null,
  Links: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
}));

type AppDirectoryGlobal = { __reactRouterAppDirectory?: string };
(globalThis as AppDirectoryGlobal).__reactRouterAppDirectory = fileURLToPath(
  new URL("../../app", import.meta.url),
);

const { flatRoutes } = await import("@react-router/fs-routes");
const { matchRoutes } = await import("react-router");

type RouteEntry = { id?: string; path?: string; children?: RouteEntry[] };
const ROUTES = (await flatRoutes()) as RouteEntry[];

function winnerOf(url: string): string | undefined {
  const match = matchRoutes(ROUTES as never, url) as Array<{ route: { id?: string } }> | null;
  return match?.at(-1)?.route.id;
}

afterEach(() => vi.unstubAllEnvs());

async function renderNotFound(url: string, headers: Record<string, string>) {
  const routes: RouteObject[] = [
    {
      id: "root",
      path: "/",
      loader: (args) => root.loader(args as never),
      Component: () => createElement(root.Layout, null, createElement(root.default)),
      ErrorBoundary: () => {
        const error = useRouteError();
        return createElement(
          root.Layout,
          null,
          createElement(root.ErrorBoundary as never, { error } as never),
        );
      },
      children: [
        {
          id: "routes/$",
          path: "*",
          loader: (args) => splat.loader(args as never),
          Component: splat.default,
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(url, { headers }));
  if (context instanceof Response) throw new Error("unexpected redirect");
  expect(context.statusCode).toBe(404);
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(createElement(StaticRouterProvider, { router, context, hydrate: false }));
}

describe("unmatched URLs", () => {
  it("resolve to the catch-all route, signed in or not, and leave real routes alone", () => {
    expect(winnerOf("/does-not-exist")).toBe("routes/$");
    expect(winnerOf("/m/does-not-exist")).toBe("routes/$");
    expect(winnerOf("/some/deeper/path")).toBe("routes/$");
    expect(winnerOf("/healthz")).toBe("routes/healthz");
    expect(winnerOf("/login")).toBe("routes/login");
    expect(winnerOf("/api/search")).toBe("routes/api.search");
    expect(winnerOf("/m")).not.toBe("routes/$");
    expect(winnerOf("/tasks")).not.toBe("routes/$");
    expect(winnerOf("/rooms/some-room")).not.toBe("routes/$");
  });

  it("answer with a bare 404 Response from the loader", () => {
    let thrown: unknown;
    try {
      splat.loader({} as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it("render the German 404 for the German cookie", async () => {
    const html = await renderNotFound("http://localhost/does-not-exist", { cookie: "locale=de" });
    expect(html).toMatch(/<html[^>]*lang="de"/);
    expect(html).toContain("<h1>404</h1>");
    expect(html).toContain("Die gesuchte Seite existiert nicht oder wurde verschoben.");
    expect(html).toContain("Seite nicht gefunden · Jiangtang");
    expect(html).not.toContain("Not Found");
  });

  it("render the English 404 for the English cookie, also under /m", async () => {
    for (const path of ["/does-not-exist", "/m/does-not-exist"]) {
      const html = await renderNotFound(`http://localhost${path}`, { cookie: "locale=en" });
      expect(html).toMatch(/<html[^>]*lang="en"/);
      expect(html).toContain("The page you are looking for does not exist or has moved.");
      expect(html).toContain("Page not found · Jiangtang");
    }
  });

  it("follow Accept-Language, then DEFAULT_LOCALE, without a cookie", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "en");
    const accept = await renderNotFound("http://localhost/nope", {
      "accept-language": "de-DE,de;q=0.9",
    });
    expect(accept).toMatch(/<html[^>]*lang="de"/);
    expect(accept).toContain("Seite nicht gefunden");

    vi.stubEnv("DEFAULT_LOCALE", "de");
    const fallback = await renderNotFound("http://localhost/nope", { "accept-language": "fr-FR" });
    expect(fallback).toMatch(/<html[^>]*lang="de"/);
    expect(fallback).toContain("Seite nicht gefunden");
  });
});
