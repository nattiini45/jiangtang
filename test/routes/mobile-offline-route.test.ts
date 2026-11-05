import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  StaticRouterProvider,
  createStaticHandler,
  createStaticRouter,
  type RouteObject,
} from "react-router";
import { describe, expect, it, vi } from "vitest";
import { createTab, describeOfflineReload } from "~/lib/pwa/__tests__/reload-harness";
import { OFFLINE_RELOAD_SCRIPT } from "~/lib/pwa/offline-reload-script";
import * as root from "~/root";
import * as offline from "~/routes/m.offline/route";

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Meta: () => null,
  Links: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
}));

/** The server-rendered page, which is all the worker caches and all an offline device has. */
async function renderOffline() {
  const routes: RouteObject[] = [
    {
      id: "root",
      path: "/",
      loader: (args) => root.loader(args as never),
      Component: () => createElement(root.Layout, null, createElement(root.default)),
      children: [{ id: "offline", path: "m/offline", Component: offline.default }],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("http://localhost/m/offline"));
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(createElement(StaticRouterProvider, { router, context, hydrate: false }));
}

const routeScript = async () => {
  const scripts = [...(await renderOffline()).matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return scripts.map((m) => m[1]!).filter((s) => s.includes("online"));
};

describe("/m/offline route", () => {
  it("carries the reload script in its own markup, because offline nothing hydrates it", async () => {
    const html = await renderOffline();

    expect(html).toContain(`<script>${OFFLINE_RELOAD_SCRIPT}</script>`);
    expect(await routeScript()).toHaveLength(1);
  });

  describeOfflineReload("route markup", async () => (await routeScript())[0]!);

  it("does not touch the tab when the script runs without a connection", async () => {
    const page = createTab().load((await routeScript())[0]!, { onLine: false });

    expect(page.reloads()).toBe(0);
    expect(page.delays()).toEqual([]);
  });
});
