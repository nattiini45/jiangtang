import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  createStaticHandler,
  createStaticRouter,
  Outlet,
  StaticRouterProvider,
  type RouteObject,
} from "react-router";
import { describe, expect, it } from "vitest";
import { MobileRouteErrorBoundary } from "~/components/mobile/mobile-route-error-boundary";
import {
  NotificationList,
  notificationLabelParams,
} from "~/components/notifications/notification-list";
import type { Notification } from "~/generated/prisma/client";
import type { Locale } from "~/i18n/locales";

async function renderAt(locale: Locale, child: RouteObject) {
  const handler = createStaticHandler([
    {
      id: "root",
      path: "/",
      loader: () => ({ locale }),
      Component: () => createElement(Outlet),
      children: [{ path: "m/test", Component: () => null, ...child }],
    },
  ]);
  const context = await handler.query(new Request("http://localhost/m/test?filter=1"));
  if (context instanceof Response) throw new Error("Unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  return {
    status: context.statusCode,
    html: renderToString(createElement(StaticRouterProvider, { router, context, hydrate: false })),
  };
}

describe("mobile recovery", () => {
  for (const locale of ["de", "en"] as const) {
    it(`shows structured 404 recovery without a generic unexpected error in ${locale}`, async () => {
      const result = await renderAt(locale, {
        loader: () => {
          throw Response.json({ message: "Structured missing entry" }, { status: 404 });
        },
        ErrorBoundary: MobileRouteErrorBoundary,
      });
      expect(result.status).toBe(404);
      expect(result.html).toContain(locale === "de" ? "Eintrag nicht gefunden" : "Entry not found");
      expect(result.html).toContain('href="/m"');
      expect(result.html).not.toContain("unexpected");
      expect(result.html).not.toContain("Structured missing entry");
    });

    it(`offers a GET reload and capture recovery for a 500 in ${locale}`, async () => {
      const result = await renderAt(locale, {
        loader: () => {
          throw Response.json({ message: "Internal diagnostic detail" }, { status: 500 });
        },
        ErrorBoundary: MobileRouteErrorBoundary,
      });
      expect(result.status).toBe(500);
      expect(result.html).toContain(
        locale === "de" ? "Seite konnte nicht angezeigt werden" : "The page could not be shown",
      );
      expect(result.html).toContain('href="/m/test?filter=1"');
      expect(result.html).toContain('href="/m"');
      expect(result.html).not.toContain("Internal diagnostic detail");
    });
  }
});

describe("mobile notification variant", () => {
  const notification: Notification = {
    id: "synthetic-notification",
    userId: "synthetic-user",
    entityType: "task",
    entityId: "synthetic-task",
    type: "TASK_DUE_SOON",
    data: {
      title: "Medientechnik-Verbindungsprüfung im Hörsaal",
      dueAt: "2027-03-30T22:00:00.000Z",
    },
    readAt: null,
    createdAt: new Date("2027-03-30T22:00:00.000Z"),
  };

  it("keeps desktop ISO labels and adds locale-aware mobile due dates", () => {
    expect(notificationLabelParams(notification.type, notification.data).date).toBe("2027-03-31");
    expect(notificationLabelParams(notification.type, notification.data, "de").date).toBe(
      "31.03.2027",
    );
    expect(notificationLabelParams(notification.type, notification.data, "en").date).toBe(
      "31 Mar 2027",
    );
  });

  it("leaves the default desktop rendering unchanged and wraps the mobile variant", async () => {
    const desktop = await renderAt("en", {
      Component: () => createElement(NotificationList, { notifications: [notification] }),
    });
    const mobile = await renderAt("en", {
      Component: () =>
        createElement(NotificationList, { notifications: [notification], mobile: true }),
    });
    expect(desktop.html).toContain("2027-03-31 00:00");
    expect(desktop.html).toContain("truncate");
    expect(mobile.html).toContain("31 Mar 2027");
    expect(mobile.html).not.toContain("truncate");
    expect(mobile.html).toContain("min-h-11");
  });
});
