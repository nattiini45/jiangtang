import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import * as root from "~/root";

vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  Meta: () => null,
  Links: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
}));

async function head(theme: "system" | "light" | "dark") {
  const handler = createStaticHandler([
    {
      id: "root",
      path: "/m",
      loader: (args) => root.loader(args as never),
      Component: () => createElement(root.Layout, null, createElement("main")),
    },
  ]);
  const context = await handler.query(
    new Request("https://app.test/m", { headers: { Cookie: `theme=${theme}` } }),
  );
  if (context instanceof Response) throw new Error("unexpected redirect");
  return renderToString(
    createElement(StaticRouterProvider, {
      router: createStaticRouter(handler.dataRoutes, context),
      context,
      hydrate: false,
    }),
  );
}

describe("installed application document metadata", () => {
  it("declares standalone iOS metadata, safe-area viewport and a real apple icon", async () => {
    const html = await head("system");
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Jiangtang"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="default"');
    expect(html).toContain("viewport-fit=cover");
    expect(root.links()).toContainEqual({
      rel: "apple-touch-icon",
      sizes: "180x180",
      href: "/apple-touch-icon.png",
    });
  });

  it("uses light and dark floor colors for system chrome and the pre-stylesheet canvas", async () => {
    const html = await head("system");
    expect(html).toContain(
      'name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)"',
    );
    expect(html).toContain(
      'name="theme-color" content="#171717" media="(prefers-color-scheme: dark)"',
    );
    expect(html).toContain("html{background:#fafafa}html.dark{background:#171717}");
  });

  it.each([
    ["light", "#fafafa"],
    ["dark", "#171717"],
  ] as const)("honors an explicit %s chrome preference", async (theme, floor) => {
    const html = await head(theme);
    expect(html).toContain(`name="theme-color" content="${floor}"`);
    expect(html).not.toContain('media="(prefers-color-scheme:');
  });
});
