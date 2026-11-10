import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
  type RouteObject,
} from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { runWithLocale } from "~/i18n/request-locale.server";
import { requireUser } from "~/lib/auth.server";
import { emitChange } from "~/lib/realtime/emit.server";
import { configuredCalendarFixture } from "../calendar-config";

configuredCalendarFixture();
vi.mock("~/lib/auth.server", () => ({
  requireUser: vi.fn(async () => ({ id: null, name: "Synthetic member", initials: "SM" })),
}));
vi.mock("~/lib/realtime/emit.server", () => ({ emitChange: vi.fn() }));

const desktop = await import("~/routes/_desktop.events.$id/route");
const mobile = await import("~/routes/m.events.$id/route");
const run = `event-reopen-${crypto.randomUUID()}`;
let event: Awaited<ReturnType<typeof db.event.create>>;

beforeAll(async () => {
  event = await db.event.create({
    data: {
      title: run,
      status: "CANCELLED",
      startsAt: new Date("2041-08-01T10:00:00Z"),
      endsAt: new Date("2041-08-01T12:00:00Z"),
    },
  });
});
afterAll(async () => {
  await db.calendarOutbox.deleteMany({ where: { eventUid: event.uid } });
  await db.event.delete({ where: { id: event.id } });
  await db.$disconnect();
});

for (const [surface, route, prefix] of [
  ["desktop", desktop, ""],
  ["mobile", mobile, "/m"],
] as const) {
  const post = (id: string, locale = "en") => {
    const form = new FormData();
    form.set("_action", "reopenEvent");
    return route.action({
      params: { id },
      request: new Request(`http://localhost${prefix}/events/${id}`, {
        method: "POST",
        body: form,
        headers: { "Accept-Language": locale },
      }),
    } as never);
  };

  describe(`${surface} deliberate event reopen`, () => {
    it.each(["en", "de"] as const)("renders clear copy and posts once in %s", async (locale) => {
      await db.event.update({ where: { id: event.id }, data: { status: "CANCELLED" } });
      const url = `http://localhost${prefix}/events/${event.id}`;
      const data = await route.loader({
        params: { id: event.id },
        request: new Request(url),
      } as never);
      const routes: RouteObject[] = [
        {
          id: "root",
          loader: () => ({ locale }),
          children: [
            {
              path: `${prefix}/events/:id`,
              Component: () =>
                createElement(route.default as ComponentType<never>, { loaderData: data } as never),
            },
          ],
        },
      ];
      const handler = createStaticHandler(routes);
      const context = await handler.query(new Request(url));
      if (context instanceof Response) throw new Error("Unexpected redirect");
      const router = createStaticRouter(handler.dataRoutes, context);
      const html = renderToStaticMarkup(
        createElement(StaticRouterProvider, { router, context, hydrate: false }),
      );
      expect(html).toContain(t(locale, "events.detail.reopenHint"));
      expect(html).toContain(t(locale, "events.detail.reopen"));
      expect(html).toContain('name="_action" value="reopenEvent"');
      expect(html).toContain("aria-describedby=");

      vi.mocked(emitChange).mockClear();
      const audits = await db.activityLog.count({ where: { entityId: event.id } });
      const outbox = await db.calendarOutbox.count({ where: { eventUid: event.uid } });
      const response = await runWithLocale(locale, () => post(event.id, locale));
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).headers.get("location")).toBe(`${prefix}/events/${event.id}`);
      const saved = await db.event.findUniqueOrThrow({ where: { id: event.id } });
      expect(saved.status).toBe("PLANNED");
      expect(await db.activityLog.count({ where: { entityId: event.id } })).toBe(audits + 1);
      expect(await db.calendarOutbox.count({ where: { eventUid: event.uid } })).toBe(outbox + 1);
      expect(emitChange).toHaveBeenCalledExactlyOnceWith({
        entityType: "event",
        id: event.id,
        op: "updated",
      });

      const stale = await runWithLocale(locale, () => post(event.id, locale));
      expect(stale).toEqual({ error: t(locale, "events.detail.reopenUnavailable") });
      expect(await db.event.findUniqueOrThrow({ where: { id: event.id } })).toEqual(saved);
      expect(await db.activityLog.count({ where: { entityId: event.id } })).toBe(audits + 1);
      expect(await db.calendarOutbox.count({ where: { eventUid: event.uid } })).toBe(outbox + 1);
      expect(emitChange).toHaveBeenCalledTimes(1);
    });

    it("returns missing before state validation and authenticates before looking up the event", async () => {
      vi.mocked(emitChange).mockClear();
      const audits = await db.activityLog.count({ where: { entityId: `${run}-missing` } });
      await expect(post(`${run}-missing`)).rejects.toMatchObject({ status: 404 });
      vi.mocked(requireUser).mockRejectedValueOnce(
        new Response(null, { status: 302, headers: { Location: "/login" } }),
      );
      await expect(post(`${run}-missing`)).rejects.toMatchObject({ status: 302 });
      expect(await db.activityLog.count({ where: { entityId: `${run}-missing` } })).toBe(audits);
      expect(emitChange).not.toHaveBeenCalled();
    });
  });
}
