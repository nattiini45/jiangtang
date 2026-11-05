import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  StaticRouterProvider,
  createStaticHandler,
  createStaticRouter,
  useLoaderData,
  type RouteObject,
} from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as login from "~/routes/login/route";
import { purgeSignedInCaches } from "~/lib/pwa/purge-caches";

// Server rendering never runs effects, so mounting is simulated by collecting the ones the sign-in
// page registers and running them afterwards, like React does after the first commit.
const mounted = vi.hoisted(() => ({ effects: [] as Array<() => void> }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => void) => void mounted.effects.push(effect),
}));
vi.mock("~/lib/pwa/purge-caches", () => ({ purgeSignedInCaches: vi.fn(async () => []) }));

async function renderLogin() {
  const routes: RouteObject[] = [
    {
      id: "login",
      path: "/login",
      loader: (args) => login.loader(args as never),
      Component: () =>
        createElement(login.default as never, {
          loaderData: useLoaderData(),
          actionData: undefined,
        }),
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("http://localhost/login"));
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  renderToString(createElement(StaticRouterProvider, { router, context, hydrate: false }));
}

describe("sign-in page and the cached signed-in pages", () => {
  beforeEach(() => {
    mounted.effects.length = 0;
    vi.mocked(purgeSignedInCaches).mockClear();
  });

  it("empties them once it has mounted, and not before", async () => {
    await renderLogin();
    expect(purgeSignedInCaches).not.toHaveBeenCalled();

    for (const effect of mounted.effects) effect();

    expect(purgeSignedInCaches).toHaveBeenCalledTimes(1);
  });
});
