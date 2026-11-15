import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "~/lib/auth.server";
import { getWorkspaceCalendar } from "~/domains/calendar/calendar.queries.server";
import { loader } from "~/routes/m.calendar/route";

vi.mock("~/lib/auth.server", () => ({ requireUser: vi.fn() }));
vi.mock("~/domains/calendar/calendar.queries.server", () => ({
  getWorkspaceCalendar: vi.fn(async () => ({ entries: [] })),
  calendarChoices: [],
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T23:30:00Z"));
});

afterEach(() => vi.useRealTimers());

const load = (query = "") =>
  loader({ request: new Request(`http://localhost/m/calendar${query}`) } as never);

describe("mobile calendar default URL", () => {
  it("renders the current Berlin day without a redirect so the PWA can precache it", async () => {
    const result = await load();
    expect(result.date).toBe("2026-11-09");
    expect(requireUser).toHaveBeenCalledOnce();
    expect(getWorkspaceCalendar).toHaveBeenCalledWith({
      from: new Date("2026-11-08T23:00:00Z"),
      to: new Date("2026-11-09T23:00:00Z"),
      startDay: expect.any(Number),
      endDay: expect.any(Number),
      kinds: [],
      roomId: undefined,
      equipmentId: undefined,
      status: undefined,
    });
  });

  it("keeps an explicit selected day", async () => {
    expect((await load("?date=2026-10-25")).date).toBe("2026-10-25");
  });

  it("still canonicalizes an invalid explicit date", async () => {
    await expect(load("?date=invalid")).rejects.toMatchObject({ status: 302 });
    expect(getWorkspaceCalendar).not.toHaveBeenCalled();
  });

  it("requires authentication before querying the calendar", async () => {
    vi.mocked(requireUser).mockRejectedValueOnce(new Response(null, { status: 401 }));
    await expect(load()).rejects.toMatchObject({ status: 401 });
    expect(getWorkspaceCalendar).not.toHaveBeenCalled();
  });
});
