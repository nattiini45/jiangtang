import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Outlet,
  StaticRouterProvider,
  createStaticHandler,
  createStaticRouter,
  type RouteObject,
} from "react-router";
import { describe, expect, it } from "vitest";
import { CaptureQueueList, CaptureQueuePanel } from "../capture-form";
import { QueueBadge } from "../queue-badge";
import type { QueuedCapture } from "~/lib/pwa/offline-queue";

/**
 * The sign-in state of the mobile queue UI, rendered server-side inside a
 * static router: `useT` reads the locale from the root loader and `Link` needs
 * a router, so both are real. The hooks that read IndexedDB are not involved.
 */
async function render(locale: "de" | "en", element: ReactElement): Promise<string> {
  const routes: RouteObject[] = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale }),
      Component: Outlet,
      children: [{ id: "page", path: "m/x", Component: () => element }],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("http://localhost/m/x"));
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToStaticMarkup(
    createElement(StaticRouterProvider, { router, context, hydrate: false }),
  );
}

const entry = (clientId: string, over: Partial<QueuedCapture> = {}): QueuedCapture => ({
  clientId,
  url: "/m/tasks/new",
  fields: { title: `Titel ${clientId}` },
  createdAt: 1,
  ...over,
});

describe("CaptureQueueList", () => {
  const list = (signInNeeded: boolean) =>
    createElement(CaptureQueueList, {
      url: "/m/tasks/new",
      entries: [entry("ca1"), entry("cb2")],
      signInNeeded,
      onDiscard: () => {},
    });

  it("shows the sign-in notice with a link back to this capture page", async () => {
    const de = await render("de", list(true));
    expect(de).toContain('role="status"');
    expect(de).toContain("Melde dich erneut an");
    expect(de).toContain('href="/login?next=%2Fm%2Ftasks%2Fnew"');
    expect(de).toContain(">Anmelden<");
    const en = await render("en", list(true));
    expect(en).toContain("Sign in again to send it.");
    expect(en).toContain('href="/login?next=%2Fm%2Ftasks%2Fnew"');
  });

  it("shows the notice for entries that carry no flag themselves", async () => {
    // The flag lives on the entry the pass stopped at, maybe on another page.
    const html = await render("en", list(true));
    expect(html).toContain("Titel ca1");
    expect(html).toContain("Titel cb2");
    expect(html).toContain("Sign in");
  });

  it("shows no notice while the session is fine, and still lists the entries", async () => {
    const html = await render("en", list(false));
    expect(html).not.toContain("/login");
    expect(html).not.toContain('role="status"');
    expect(html).toContain("Titel ca1");
  });
});

describe("CaptureQueuePanel", () => {
  const panel = (entries: QueuedCapture[], authRequired: boolean) =>
    createElement(CaptureQueuePanel, {
      url: "/m/tasks/new",
      entries,
      authRequired,
      onDiscard: () => {},
    });
  const elsewhere = entry("cn1", { url: "/m/notes/new" });

  it("asks for the sign-in even when every waiting entry belongs to another page", async () => {
    const html = await render("en", panel([elsewhere], true));
    expect(html).toContain("Sign in again to send it.");
    expect(html).toContain('href="/login?next=%2Fm%2Ftasks%2Fnew"');
    // No list of its own, and none of the other page's entries.
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("Titel cn1");
  });

  it("lists only this page's entries next to the notice", async () => {
    const html = await render("en", panel([entry("ca1"), elsewhere], true));
    expect(html).toContain("Titel ca1");
    expect(html).not.toContain("Titel cn1");
    expect(html).toContain("Sign in again to send it.");
  });

  it("renders nothing when the session is fine and no entry is this page's", async () => {
    expect(await render("en", panel([elsewhere], false))).toBe("");
    expect(await render("en", panel([], false))).toBe("");
  });

  it("lists this page's entries without a notice while the session is fine", async () => {
    const html = await render("en", panel([entry("ca1")], false));
    expect(html).toContain("Titel ca1");
    expect(html).not.toContain("/login");
  });
});

describe("QueueBadge", () => {
  it("is a 44 px link to sign-in that names the number", async () => {
    const en = await render("en", createElement(QueueBadge, { pending: 3, authRequired: true }));
    expect(en).toContain('href="/login?next=%2Fm"');
    expect(en).toContain("min-h-11");
    expect(en).toContain('aria-label="Sign in to send the entries saved on this device (3)"');
    const de = await render("de", createElement(QueueBadge, { pending: 3, authRequired: true }));
    expect(de).toContain(
      'aria-label="Anmelden, um die auf diesem Gerät gespeicherten Einträge zu senden (3)"',
    );
  });

  it("is a plain status counter with a name while the session is fine", async () => {
    const html = await render("en", createElement(QueueBadge, { pending: 2, authRequired: false }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Entries waiting to be sent (2)"');
    expect(html).not.toContain("<a ");
  });

  it("renders nothing without pending entries", async () => {
    const html = await render("en", createElement(QueueBadge, { pending: 0, authRequired: true }));
    expect(html).toBe("");
  });
});
