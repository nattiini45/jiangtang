import { describe, expect, it, vi } from "vitest";
import { loader } from "~/routes/_desktop.events._index/route";
import { loader as mobileLoader } from "~/routes/m.events._index/route";

vi.mock("~/lib/auth.server", () => ({ requireUser: vi.fn(async () => ({ id: "synthetic" })) }));

describe("legacy event calendar redirects", () => {
  it("keeps an old mobile agenda bookmark on its day", async () => {
    await expect(
      mobileLoader({
        request: new Request("http://localhost/m/events?date=2026-11-09&room=room&kinds=tasks"),
      } as never),
    ).rejects.toMatchObject({ status: 302, headers: expect.any(Headers) });
    try {
      await mobileLoader({
        request: new Request("http://localhost/m/events?date=2026-11-09&room=room&kinds=tasks"),
      } as never);
    } catch (response) {
      expect((response as Response).headers.get("Location")).toBe(
        "/m/calendar?date=2026-11-09&room=room&kinds=tasks",
      );
    }
  });
  it.each(["month", "week", "day", "rooms", "calendar"])(
    "redirects %s and retains all address state",
    async (view) => {
      const params = new URLSearchParams({
        view,
        date: "2026-11-09",
        room: "room",
        equipment: "device",
        status: "CONFIRMED",
        tasks: "1",
        kinds: "events,tasks",
      });
      try {
        await loader({ request: new Request(`http://localhost/events?${params}`) } as never);
        expect.fail("expected redirect");
      } catch (response) {
        expect(response).toBeInstanceOf(Response);
        const redirect = response as Response;
        expect(redirect.status).toBe(302);
        const url = new URL(redirect.headers.get("Location")!, "http://localhost");
        expect(url.pathname).toBe("/calendar");
        expect(Object.fromEntries(url.searchParams)).toEqual({
          ...Object.fromEntries(params),
          view: view === "calendar" ? "month" : view,
        });
      }
    },
  );
});
