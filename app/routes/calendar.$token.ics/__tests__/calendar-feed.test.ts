import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * calendar.$token.ics loader. The feed is public but token-gated, so a wrong token
 * answers 404 and a valid one answers with a private, short-lived Cache-Control
 * header: a shared cache must never store a body that the feed URL's token unlocks.
 * The event query is mocked, so this suite checks the HTTP contract, not the iCal
 * rendering (ical.test.ts covers that).
 */

const FEED_TOKEN = "f".repeat(64);

vi.mock("~/lib/calendar/ical.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/calendar/ical.server")>();
  return { ...actual, loadFeedEvents: vi.fn(async () => []) };
});

const { loader } = await import("~/routes/calendar.$token.ics/route");

type LoaderArgs = Parameters<typeof loader>[0];

function args(token: string): LoaderArgs {
  return {
    params: { token },
    request: new Request(`http://localhost/calendar/${token}.ics`),
    context: {},
  } as unknown as LoaderArgs;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("calendar.$token.ics loader", () => {
  it("answers a valid token with the feed and a private, five-minute Cache-Control", async () => {
    vi.stubEnv("ICAL_FEED_TOKEN", FEED_TOKEN);

    const res = (await loader(args(FEED_TOKEN))) as Response;

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=300");
    expect(await res.text()).toContain("BEGIN:VCALENDAR");
  });

  it("answers a wrong token with a 404 and no feed body", async () => {
    vi.stubEnv("ICAL_FEED_TOKEN", FEED_TOKEN);

    const thrown = await loader(args("0".repeat(64))).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });
});
