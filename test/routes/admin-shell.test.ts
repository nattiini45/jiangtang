import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NAV, navigationFor } from "~/components/layout/nav";
import { verbsFor } from "~/components/command/verbs";
import { ENVIRONMENT_VARIABLES } from "~/lib/environment.server";
import { CONFIG_REGISTRY } from "~/lib/config.server";
import { buildInfo } from "~/lib/version.server";
import * as about from "~/routes/_desktop.admin.about/route";
import * as admin from "~/routes/_desktop.admin._index/route";
import * as legacy from "~/routes/_desktop.admin.index/route";

const access = vi.hoisted(() => ({ role: "ADMIN" }));
vi.mock("~/lib/auth.server", () => ({
  requireRole: vi.fn(async (_request: Request, role: string) => {
    if (role !== access.role) throw new Response(null, { status: 403 });
    return { role: access.role };
  }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  access.role = "ADMIN";
});
const args = (path: string) => ({ request: new Request(`http://localhost${path}`) }) as never;

describe("administration shell", () => {
  it.each([[legacy, "/admin/search-index"]])(
    "redirects to the canonical page",
    async (route, target) => {
      expect((await route.loader(args("/admin"))).headers.get("Location")).toBe(target);
    },
  );

  it.each([admin, legacy, about])("denies a member before returning admin data", async (route) => {
    access.role = "MEMBER";
    await expect(route.loader(args("/admin"))).rejects.toMatchObject({ status: 403 });
  });

  it("keeps workspace and admin navigation separate for both roles", () => {
    const workspace = navigationFor(true, "/").entries.map((e) => e.to);
    expect(workspace).toContain("/admin");
    expect(workspace).not.toContain("/admin/users");
    expect(workspace).not.toContain("/admin/search-index");
    expect(workspace[workspace.indexOf("/activity") + 1]).toBe("/analytics");
    expect(NAV.find((e) => e.to === "/analytics")?.group).toBe("work");
    expect(navigationFor(false, "/").entries.every((e) => !e.adminOnly)).toBe(true);
    expect(navigationFor(false, "/admin/users")).toEqual(navigationFor(false, "/"));
    for (const path of [
      "/admin",
      "/admin/users/one",
      "/admin/invitations",
      "/admin/search-index",
      "/admin/about",
    ]) {
      const nav = navigationFor(true, path);
      expect(nav.groups.map((g) => g.id)).toEqual(["back", "people", "data", "system"]);
      expect(nav.entries.map((e) => e.to)).toEqual([
        "/",
        "/admin",
        "/admin/users",
        "/admin/invitations",
        "/admin/search-index",
        "/admin/about",
      ]);
    }
    expect(navigationFor(true, "/admin").entries[1]).toMatchObject({
      labelKey: "admin.overview.title",
      end: true,
    });
    expect(
      verbsFor({ admin: true, locale: "en" }).find((v) => v.id === "goto-admin")?.label,
    ).toContain("Administration");
    for (const entry of NAV.filter((e) => e.adminArea)) {
      const id = `goto-${entry.to.replaceAll("/", "")}`;
      expect(verbsFor({ admin: true, locale: "en" }).some((v) => v.id === id)).toBe(true);
      expect(verbsFor({ admin: false, locale: "en" }).some((v) => v.id === id)).toBe(false);
    }
  });

  it("accounts for every documented environment variable", () => {
    const excluded: Record<string, string> = {
      DATABASE_URL_TEST: "Vitest harness",
      DATABASE_URL_E2E: "Playwright harness",
      E2E_BASE_URL: "Playwright harness",
      SHADOW_DATABASE_URL: "Migration authoring only",
    };
    const documented = [
      ...readFileSync(".env.example", "utf8").matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm),
    ].map((m) => m[1]);
    const listed = new Set<string>(CONFIG_REGISTRY.map((v) => v.name));
    expect(documented.filter((name) => !listed.has(name) && !excluded[name])).toEqual([]);
    expect(
      Object.keys(excluded).every((name) => documented.includes(name) && !listed.has(name)),
    ).toBe(true);
  });

  it.each(["en", "de"])(
    "never serializes environment values in data or the %s page",
    async (locale) => {
      const sentinel = "secret-sentinel-never-send-to-browser";
      for (const variable of ENVIRONMENT_VARIABLES.filter((v) => v.name !== "APP_COMMIT"))
        vi.stubEnv(variable.name, sentinel);
      const loaded = await about.loader(args("/admin/about"));
      expect(JSON.stringify(loaded)).not.toContain(sentinel);
      expect(loaded.variables.find((v) => v.name === "ADMIN_PASSWORD")).toMatchObject({
        set: true,
        expectedUnset: true,
      });
      vi.stubEnv("ADMIN_PASSWORD", "");
      expect(
        (await about.loader(args("/admin/about"))).variables.find(
          (v) => v.name === "ADMIN_PASSWORD",
        )?.set,
      ).toBe(false);
      const handler = createStaticHandler([
        {
          id: "root",
          path: "/",
          loader: () => ({ locale }),
          children: [
            {
              path: "admin/about",
              Component: () => createElement(about.default, { loaderData: loaded } as never),
            },
          ],
        },
      ]);
      const context = await handler.query(new Request("http://localhost/admin/about"));
      if (context instanceof Response) throw new Error("unexpected redirect");
      const router = createStaticRouter(handler.dataRoutes, context);
      const html = renderToString(createElement(StaticRouterProvider, { router, context }));
      expect(html).not.toContain(sentinel);
      expect(html).toContain("ADMIN_PASSWORD");
      expect(html).toContain(
        locale === "en" ? "Remove after setup" : "Nach der Einrichtung entfernen",
      );
      expect(html).toContain(
        buildInfo.commit === "unknown"
          ? locale === "en"
            ? "has not supplied a commit"
            : "keinen Commit übergeben"
          : buildInfo.commit,
      );
    },
  );
});
