import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  StaticRouterProvider,
  createStaticHandler,
  createStaticRouter,
  useLoaderData,
  type RouteObject,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as root from "~/root";
import * as login from "~/routes/login/route";
import * as invite from "~/routes/accept-invite.$token/route";
import { LanguageSwitcher } from "~/components/i18n/language-switcher";

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  Meta: () => null,
  Links: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
}));

afterEach(() => vi.unstubAllEnvs());

function loginPost(headers: Record<string, string>): Request {
  return new Request("http://localhost/login", {
    method: "POST",
    headers,
    body: new URLSearchParams({
      email: "nobody@example.test",
      password: "definitely-wrong",
      next: "/",
    }),
  });
}

async function renderAt(url: string, headers: Record<string, string>, child: RouteObject) {
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
  const context = await handler.query(new Request(url, { headers }));
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(createElement(StaticRouterProvider, { router, context, hydrate: false }));
}

describe("login in English and German", () => {
  const loginRoute: RouteObject = {
    id: "login",
    path: "login",
    loader: (args) => login.loader(args as never),
    Component: () =>
      createElement(login.default as never, { loaderData: useLoaderData(), actionData: undefined }),
  };

  it("renders the form in English without cookie or supported Accept-Language", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "");
    const html = await renderAt(
      "http://localhost/login",
      { "accept-language": "fr-FR" },
      loginRoute,
    );
    expect(html).toMatch(/<html[^>]*lang="en"/);
    expect(html).toContain("Sign in to your AV workspace.");
    expect(html).toContain(">Email<");
    expect(html).toContain(">Password<");
    expect(html).toContain(">Sign in</button>");
  });

  it("renders the German form for Accept-Language de", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "");
    const html = await renderAt(
      "http://localhost/login",
      { "accept-language": "de-DE,de;q=0.9" },
      loginRoute,
    );
    expect(html).toMatch(/<html[^>]*lang="de"/);
    expect(html).toContain("Anmeldung für dein AV-Workspace.");
    expect(html).toContain(">Passwort<");
    expect(html).toContain(">Anmelden</button>");
  });

  it("answers invalid credentials in the request language", async () => {
    const en = await login.action({ request: loginPost({ cookie: "locale=en" }) } as never);
    expect(en).toEqual({ error: "Invalid email or password." });
    const de = await login.action({ request: loginPost({ cookie: "locale=de" }) } as never);
    expect(de).toEqual({ error: "Ungültige Anmeldedaten." });
  });

  it("titles the page per language", () => {
    const matches = (locale: string) => [{ id: "root", loaderData: { locale } }];
    expect(login.meta({ matches: matches("en") } as never)).toEqual([
      { title: "Sign in · Jiangtang" },
    ]);
    expect(login.meta({ matches: matches("de") } as never)).toEqual([
      { title: "Anmelden · Jiangtang" },
    ]);
  });
});

describe("accept-invite", () => {
  async function unknownInvite(headers: Record<string, string>): Promise<Response> {
    try {
      await invite.loader({
        params: { token: "no-such-token" },
        request: new Request("http://localhost/accept-invite/no-such-token", { headers }),
      } as never);
    } catch (e) {
      return e as Response;
    }
    throw new Error("expected the loader to throw");
  }

  it("words the unknown/expired invite in the request language", async () => {
    const en = await unknownInvite({ cookie: "locale=en" });
    expect(en.status).toBe(404);
    expect(await en.text()).toBe("This invitation was not found or has expired.");
    const de = await unknownInvite({ cookie: "locale=de" });
    expect(await de.text()).toBe("Einladung nicht gefunden oder abgelaufen.");
  });
});

describe("LanguageSwitcher", () => {
  async function renderSwitcher(
    headers: Record<string, string>,
    url = "http://localhost/tasks?x=1",
  ) {
    return renderAt(url, headers, {
      id: "page",
      path: "tasks",
      Component: () => createElement(LanguageSwitcher),
    });
  }

  it("offers DE and EN, marks the active one and returns to the current page", async () => {
    const html = await renderSwitcher({ cookie: "locale=en" });
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Language"');
    expect(html).toMatch(/<button[^>]*value="en"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/<button[^>]*value="de"[^>]*aria-pressed="false"/);
    expect(html).toContain('action="/prefs/locale"');
    expect(html).toContain('name="next" value="/tasks?x=1"');
  });

  it("is named in German when the UI is German", async () => {
    const html = await renderSwitcher({ cookie: "locale=de" });
    expect(html).toContain('aria-label="Sprache"');
    expect(html).toMatch(/<button[^>]*value="de"[^>]*aria-pressed="true"/);
  });
});
