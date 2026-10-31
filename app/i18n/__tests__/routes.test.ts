import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  StaticRouterProvider,
  createStaticHandler,
  createStaticRouter,
  type RouteObject,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as root from "~/root";
import { action as prefsAction, loader as prefsLoader } from "~/routes/prefs.locale/route";
import { useLocale } from "~/i18n/use-t";

// Meta/Links/Scripts need the framework-mode runtime context, which a static
// render does not provide; the <html> element itself is what is under test.
vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Meta: () => null,
  Links: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
}));

afterEach(() => vi.unstubAllEnvs());

async function renderRoot(headers: Record<string, string>): Promise<string> {
  function Probe() {
    return createElement("p", { id: "probe" }, `locale:${useLocale()}`);
  }
  const routes: RouteObject[] = [
    {
      id: "root",
      path: "/",
      loader: (args) => root.loader(args as never),
      Component: () => createElement(root.Layout, null, createElement(Probe)),
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("http://localhost/", { headers }));
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(createElement(StaticRouterProvider, { router, context, hydrate: false }));
}

describe("<html lang> is rendered by the server from the resolved locale", () => {
  it("uses the locale cookie", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    const html = await renderRoot({ cookie: "locale=en" });
    expect(html).toMatch(/<html[^>]*lang="en"/);
    expect(html).toContain("locale:en");
  });

  it("uses Accept-Language without a cookie", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "en");
    const html = await renderRoot({ "accept-language": "de-DE,de;q=0.9" });
    expect(html).toMatch(/<html[^>]*lang="de"/);
    expect(html).toContain("locale:de");
  });

  it("falls back to DEFAULT_LOCALE", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "de");
    expect(await renderRoot({})).toMatch(/<html[^>]*lang="de"/);
  });
});

function post(fields: Record<string, string>): Request {
  return new Request("http://localhost/prefs/locale", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

describe("POST /prefs/locale", () => {
  it("sets the cookie and redirects to a local next path", async () => {
    const res = (await prefsAction({
      request: post({ locale: "en", next: "/tasks?x=1" }),
    } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/tasks?x=1");
    expect(res.headers.get("set-cookie")).toMatch(
      /^locale=en; Path=\/; Max-Age=31536000; SameSite=Lax/,
    );
  });

  it("refuses an open redirect target", async () => {
    const res = (await prefsAction({
      request: post({ locale: "de", next: "//evil.example" }),
    } as never)) as Response;
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie")).toContain("locale=de");
  });

  it("rejects an unsupported locale without setting a cookie", async () => {
    await expect(prefsAction({ request: post({ locale: "fr" }) } as never)).rejects.toMatchObject({
      init: { status: 400 },
    });
  });

  it("redirects a plain GET home", () => {
    const res = prefsLoader() as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });
});
