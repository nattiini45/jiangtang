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
import * as offline from "~/routes/m.offline/route";
import { MobilePhotoCapture } from "~/components/mobile/mobile-photo-capture";
import { messages, type MessageKey } from "~/i18n";

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Meta: () => null,
  Links: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
}));

afterEach(() => vi.unstubAllEnvs());

async function renderAt(locale: "en" | "de", child: RouteObject) {
  const routes: RouteObject[] = [
    {
      id: "root",
      path: "/",
      loader: (args) => root.loader(args as never),
      Component: () => createElement(root.Layout, null, createElement(root.default)),
      children: [child],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(
    new Request("http://localhost/m/x", { headers: { cookie: `locale=${locale}` } }),
  );
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(createElement(StaticRouterProvider, { router, context, hydrate: false }));
}

describe("mobile PWA strings", () => {
  const photo: RouteObject = {
    id: "photo",
    path: "m/x",
    Component: () => createElement(MobilePhotoCapture, { onCapture: () => {}, existingCount: 2 }),
  };
  const offlineRoute: RouteObject = {
    id: "offline",
    path: "m/x",
    Component: offline.default,
  };

  it("renders the photo capture in English and German", async () => {
    const en = await renderAt("en", photo);
    expect(en).toContain("Add a photo");
    expect(en).toContain("Photos on this ticket: 2");
    const de = await renderAt("de", photo);
    expect(de).toContain("Foto aufnehmen");
    expect(de).toContain("Fotos an diesem Ticket: 2");
  });

  it("renders the offline fallback page in both languages", async () => {
    expect(await renderAt("en", offlineRoute)).toContain("No connection.");
    expect(await renderAt("de", offlineRoute)).toContain("Keine Verbindung.");
  });

  it("keeps the German offline-queue wording", () => {
    const de = messages("de");
    expect(de["mobile.capture.rejected"]).toBe("Vom Server abgelehnt.");
    expect(de["mobile.capture.entryFallback"]).toBe("Eintrag");
    expect(de["mobile.capture.pending"].replace("{title}", "X")).toBe("X — ausstehend");
    expect(de["mobile.capture.discard"]).toBe("Verwerfen");
    expect(de["mobile.capture.queued"]).toBe(
      "Offline gespeichert — wird gesendet, sobald du online bist.",
    );
  });

  it("has an English translation for every mobile key that differs from German", () => {
    const en = messages("en");
    const de = messages("de");
    const keys = (Object.keys(de) as MessageKey[]).filter((k) => k.startsWith("mobile."));
    const same = keys.filter((k) => en[k] === de[k]);
    // Words that are legitimately identical in both languages.
    expect(same.sort()).toEqual(
      [
        "mobile.board.lane.BACKLOG",
        "mobile.entry.details",
        "mobile.meta.offline",
        "mobile.noteNew.body",
        "mobile.offline.title",
      ].sort(),
    );
  });
});

describe("page titles", () => {
  const routeModules = import.meta.glob<{ meta?: (args: never) => { title?: string }[] }>(
    "../../app/routes/**/route.tsx",
    { eager: true },
  );
  const matches = (locale: string) => [{ id: "root", loaderData: { locale } }];
  const titles = (locale: string) =>
    Object.entries(routeModules)
      .filter(([, mod]) => typeof mod.meta === "function")
      .map(([path, mod]) => {
        const out = mod.meta!({ matches: matches(locale), params: {} } as never);
        return [path, out.find((m) => m.title !== undefined)?.title] as const;
      });

  it("gives every titled route the Jiangtang suffix in English and German", () => {
    for (const locale of ["en", "de"]) {
      const all = titles(locale);
      expect(all.length).toBeGreaterThan(40);
      for (const [path, title] of all) {
        expect(title, `${locale} ${path}`).toMatch(/ · Jiangtang$/);
      }
    }
  });

  it("localizes the mobile route titles", () => {
    const pick = (locale: string, needle: string) =>
      titles(locale).find(([p]) => p.includes(needle))?.[1];
    expect(pick("en", "/m.tasks.new/")).toBe("Create task · Jiangtang");
    expect(pick("de", "/m.tasks.new/")).toBe("Aufgabe anlegen · Jiangtang");
    expect(pick("en", "/m.rooms._index/")).toBe("Rooms · Jiangtang");
    expect(pick("de", "/m.rooms._index/")).toBe("Räume · Jiangtang");
    expect(pick("en", "/m._index/")).toBe("Overview · Jiangtang");
    expect(pick("de", "/m._index/")).toBe("Übersicht · Jiangtang");
    expect(pick("en", "/m.quick-entry/")).toBe("Capture · Jiangtang");
    expect(pick("de", "/m.quick-entry/")).toBe("Eintrag · Jiangtang");
  });
});
