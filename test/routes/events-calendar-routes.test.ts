import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "~/lib/auth.server";
import { getCalendarData } from "~/domains/events/events.calendar.queries.server";
import { loader } from "~/routes/m.events._index/route";

vi.mock("~/lib/auth.server", () => ({ requireUser: vi.fn() }));
vi.mock("~/domains/events/events.calendar.queries.server", () => ({
  getCalendarData: vi.fn(async () => ({ events: [] })),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T23:30:00Z"));
});

afterEach(() => vi.useRealTimers());

const load = (query = "") =>
  loader({ request: new Request(`http://localhost/m/events${query}`) } as never);

describe("mobile calendar default URL", () => {
  it("renders the current Berlin day without a redirect so the PWA can precache it", async () => {
    const result = await load();
    expect(result.date).toBe("2026-11-09");
    expect(requireUser).toHaveBeenCalledOnce();
    expect(getCalendarData).toHaveBeenCalledWith({
      from: new Date("2026-11-08T23:00:00Z"),
      to: new Date("2026-11-09T23:00:00Z"),
    });
  });

  it("keeps an explicit selected day", async () => {
    expect((await load("?date=2026-10-25")).date).toBe("2026-10-25");
  });

  it("still canonicalizes an invalid explicit date", async () => {
    await expect(load("?date=invalid")).rejects.toMatchObject({ status: 302 });
    expect(getCalendarData).not.toHaveBeenCalled();
  });

  it("requires authentication before querying the calendar", async () => {
    vi.mocked(requireUser).mockRejectedValueOnce(new Response(null, { status: 401 }));
    await expect(load()).rejects.toMatchObject({ status: 401 });
    expect(getCalendarData).not.toHaveBeenCalled();
  });
});
