import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { ViewSwitch } from "~/components/layout/view-switch";

describe("contextual desktop switch", () => {
  it.each([
    ["en", "Desktop view"],
    ["de", "Desktop-Ansicht"],
  ])("renders a visible %s marker beside the destination", async (locale, marker) => {
    const handler = createStaticHandler([
      {
        id: "root",
        path: "/",
        loader: () => ({ locale }),
        children: [
          {
            path: "m/notes",
            Component: () =>
              createElement(
                ViewSwitch,
                { view: "desktop", next: "/notes/n-1", desktopLabel: true },
                "Synthetic note",
              ),
          },
        ],
      },
    ]);
    const context = await handler.query(new Request("http://localhost/m/notes"));
    if (context instanceof Response) throw new Error("Unexpected redirect");
    const router = createStaticRouter(handler.dataRoutes, context);
    const html = renderToString(
      createElement(StaticRouterProvider, { router, context, hydrate: false }),
    );
    expect(html).toContain("Synthetic note");
    expect(html).toContain(`>${marker}</span>`);
    expect(html).toContain('method="post"');
    expect(html).toContain('action="/prefs/view"');
    expect(html).toContain('value="/notes/n-1"');
  });
});
