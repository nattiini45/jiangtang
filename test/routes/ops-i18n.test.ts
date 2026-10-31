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
import * as inviteUser from "~/routes/_desktop.admin.users.new/route";
import * as eraseUser from "~/routes/_desktop.admin.users.$id_.erase/route";
import * as importHub from "~/routes/_desktop.import/route";
import * as searchPage from "~/routes/_desktop.search/route";
import * as dashboard from "~/routes/_desktop._index/route";
import * as timesheet from "~/routes/_desktop.timesheet/route";
import { AskBox } from "~/components/search/ask-box";
import { RangePicker } from "~/components/analytics/range-picker";
import { readAiConfig } from "~/lib/ai/config.server";
import { runWithLocale } from "~/i18n/request-locale.server";

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Meta: () => null,
  Links: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
}));

afterEach(() => vi.unstubAllEnvs());

async function renderAt(locale: "en" | "de", child: () => unknown) {
  const routes: RouteObject[] = [
    {
      id: "root",
      path: "/",
      loader: (args) => root.loader(args as never),
      Component: () => createElement(root.Layout, null, createElement(root.default)),
      children: [{ id: "child", index: true, Component: child as never }],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(
    new Request("http://localhost/", { headers: { cookie: `locale=${locale}` } }),
  );
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(createElement(StaticRouterProvider, { router, context, hydrate: false }));
}

const matches = (locale: string) => [{ id: "root", loaderData: { locale } }];

describe("ops pages: meta titles", () => {
  it.each([
    ["invite", inviteUser.meta, "Invite user · Jiangtang", "Benutzer einladen · Jiangtang"],
    ["import hub", importHub.meta, "Import / Export · Jiangtang", "Import / Export · Jiangtang"],
    ["search", searchPage.meta, "Search · Jiangtang", "Suche · Jiangtang"],
    ["dashboard", dashboard.meta, "Overview · Jiangtang", "Übersicht · Jiangtang"],
    ["timesheet", timesheet.meta, "Time tracking · Jiangtang", "Zeiterfassung · Jiangtang"],
  ])("%s", (_name, meta, en, de) => {
    expect((meta as (a: unknown) => unknown[])({ matches: matches("en") })).toEqual([
      { title: en },
    ]);
    expect((meta as (a: unknown) => unknown[])({ matches: matches("de") })).toEqual([
      { title: de },
    ]);
  });
});

describe("ops pages render in the request language", () => {
  it("invite page", async () => {
    const child = () =>
      createElement(inviteUser.default as never, { actionData: undefined } as never);
    const en = await renderAt("en", child);
    expect(en).toContain("Invite user");
    expect(en).toContain("Create invitation");
    expect(en).toContain("Member");
    expect(en).not.toContain("Einladung");
    const de = await renderAt("de", child);
    expect(de).toContain("Einladung erzeugen");
    expect(de).toContain("Mitglied");
  });

  it("import hub keeps the format name inside the translated sentence", async () => {
    const child = () => createElement(importHub.default as never, { actionData: undefined });
    const en = await renderAt("en", child);
    expect(en).toContain("Rooms (CSV)");
    expect(en).toContain("Download JSON export");
    expect(en).toMatch(/Read in a <code[^>]*>jiangtang-workspace<\/code> file/);
    const de = await renderAt("de", child);
    expect(de).toContain("Räume (CSV)");
    expect(de).toMatch(/Eine <code[^>]*>jiangtang-workspace<\/code>-Datei einlesen/);
  });

  it("pseudonymize page keeps the user name emphasised inside the translated sentence", async () => {
    const child = () =>
      createElement(eraseUser.default as never, {
        loaderData: { user: { id: "u1", name: "Ada Test", email: "ada@example.test" } },
        actionData: undefined,
      });
    const en = await renderAt("en", child);
    expect(en).toContain("This action cannot be undone.");
    expect(en).toMatch(
      /Name, email and initials of <strong>Ada Test<\/strong> \(ada@example.test\)/,
    );
    expect(en).toContain("To confirm, enter the email address: ada@example.test");
    const de = await renderAt("de", child);
    expect(de).toMatch(/Name, E-Mail und Initialen von <strong>Ada Test<\/strong>/);
    expect(de).toContain("Pseudonymisieren bestätigen");
  });

  it("Ask box", async () => {
    const en = await renderAt("en", () => createElement(AskBox));
    expect(en).toContain("Ask a question");
    expect(en).toContain(">Ask<");
    const de = await renderAt("de", () => createElement(AskBox));
    expect(de).toContain("Frage stellen");
  });

  it("analytics range picker", async () => {
    const en = await renderAt("en", () => createElement(RangePicker, { days: 90 }));
    expect(en).toContain(">Period<");
    expect(en).toContain("30 days");
    const de = await renderAt("de", () => createElement(RangePicker, { days: 90 }));
    expect(de).toContain("30 Tage");
  });
});

describe("AI provider status details follow the request language", () => {
  const detail = (locale: "en" | "de") =>
    runWithLocale(locale, () => readAiConfig({ EMBEDDING_MODEL: "m" }).embedding);

  it("names the missing variable in English and German", () => {
    expect(detail("en")).toEqual({
      state: "misconfigured",
      detail: "EMBEDDING_BASE_URL is missing",
    });
    expect(detail("de")).toEqual({ state: "misconfigured", detail: "EMBEDDING_BASE_URL fehlt" });
  });
});
