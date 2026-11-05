import { describe, expect, it, vi } from "vitest";
import {
  CALDAV_REQUEST_TIMEOUT_MS,
  CalDavPublisher,
  getCalDavConfig,
} from "~/lib/calendar/caldav.server";
import { getPublisher } from "~/lib/calendar/publisher-factory.server";
import { NoopPublisher, type CalendarPayload } from "~/lib/calendar/publisher.server";

/**
 * CalDAV publisher — HTTP-mocked, no live CalDAV server. Asserts the
 * PUT target (<collection>/<uid>.ics), Basic auth, iCal body contents (SUMMARY /
 * DTSTART / SEQUENCE), cancellation parity (STATUS:CANCELLED), non-2xx → throw,
 * and the config-gated factory (Noop when CALDAV_* unset).
 */

const CONFIG = {
  url: "https://dav.example.org/cal/av/",
  username: "svc",
  password: "s3cret",
};

function payload(over?: Partial<CalendarPayload>): CalendarPayload {
  return {
    uid: "evt-abc",
    title: "Sommerfest",
    description: "Aufbau ab 8",
    startsAt: new Date("2026-07-15T10:00:00Z"),
    endsAt: new Date("2026-07-15T14:00:00Z"),
    location: "Raum 32",
    timezone: "Europe/Berlin",
    sequence: 2,
    ...over,
  };
}

/** A fetch mock that records the request and returns a canned Response. */
function mockFetch(response: Response) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response);
}

const ok = () => new Response("", { status: 201 });

describe("CalDavPublisher.upsert", () => {
  it("PUTs to <collection>/<uid>.ics with Basic auth + calendar Content-Type", async () => {
    const fetchImpl = mockFetch(ok());
    const pub = new CalDavPublisher(CONFIG, fetchImpl);
    await pub.upsert(payload());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://dav.example.org/cal/av/evt-abc.ics");
    expect(init?.method).toBe("PUT");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("svc:s3cret").toString("base64")}`);
    expect(headers["Content-Type"]).toBe("text/calendar; charset=utf-8");
  });

  it("embeds SUMMARY, DTSTART and SEQUENCE in the .ics body", async () => {
    const fetchImpl = mockFetch(ok());
    const pub = new CalDavPublisher(CONFIG, fetchImpl);
    await pub.upsert(payload({ sequence: 5 }));

    const body = fetchImpl.mock.calls[0][1]?.body as string;
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("UID:evt-abc");
    expect(body).toContain("SUMMARY:Sommerfest");
    expect(body).toContain("SEQUENCE:5");
    // 10:00Z in Berlin summer (CEST, UTC+2) = 12:00 local.
    expect(body).toContain("DTSTART;TZID=Europe/Berlin:20260715T120000");
  });

  it("tolerates a collection URL without a trailing slash", async () => {
    const fetchImpl = mockFetch(ok());
    const pub = new CalDavPublisher(
      { ...CONFIG, url: "https://dav.example.org/cal/av" },
      fetchImpl,
    );
    await pub.upsert(payload());
    expect(fetchImpl.mock.calls[0][0]).toBe("https://dav.example.org/cal/av/evt-abc.ics");
  });

  it("throws with status + snippet on a non-2xx response", async () => {
    const fetchImpl = mockFetch(new Response("Forbidden — bad token", { status: 403 }));
    const pub = new CalDavPublisher(CONFIG, fetchImpl);
    await expect(pub.upsert(payload())).rejects.toThrow(/403/);
    await expect(
      new CalDavPublisher(CONFIG, mockFetch(new Response("nope", { status: 500 }))).upsert(
        payload(),
      ),
    ).rejects.toThrow(/500/);
  });
});

describe("CalDavPublisher request timeout", () => {
  it("aborts a PUT the server never answers, so a drain pass stays bounded", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const pub = new CalDavPublisher(CONFIG, fetchImpl);
      const pending = pub.upsert(payload());
      const assertion = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(CALDAV_REQUEST_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CalDavPublisher.remove", () => {
  it("PUTs a STATUS:CANCELLED VEVENT to the same resource url", async () => {
    const fetchImpl = mockFetch(ok());
    const pub = new CalDavPublisher(CONFIG, fetchImpl);
    await pub.remove("evt-abc", 3);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://dav.example.org/cal/av/evt-abc.ics");
    const body = init?.body as string;
    expect(body).toContain("UID:evt-abc");
    expect(body).toContain("SEQUENCE:3");
    expect(body).toContain("STATUS:CANCELLED");
  });
});

describe("getCalDavConfig", () => {
  const KEYS = ["CALDAV_URL", "CALDAV_USERNAME", "CALDAV_PASSWORD"] as const;
  function withEnv(vals: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void) {
    const saved = KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(vals)) process.env[k] = v;
    try {
      fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("returns null when any var is missing", () => {
    withEnv({ CALDAV_URL: "https://x/", CALDAV_USERNAME: "u" }, () => {
      expect(getCalDavConfig()).toBeNull();
    });
  });

  it("returns config when all three are present", () => {
    withEnv({ CALDAV_URL: "https://x/", CALDAV_USERNAME: "u", CALDAV_PASSWORD: "p" }, () => {
      expect(getCalDavConfig()).toEqual({ url: "https://x/", username: "u", password: "p" });
    });
  });

  it("getPublisher() falls back to NoopPublisher without env", () => {
    withEnv({}, () => {
      expect(getPublisher()).toBeInstanceOf(NoopPublisher);
    });
  });

  it("getPublisher() returns a CalDavPublisher when configured", () => {
    withEnv({ CALDAV_URL: "https://x/", CALDAV_USERNAME: "u", CALDAV_PASSWORD: "p" }, () => {
      expect(getPublisher()).toBeInstanceOf(CalDavPublisher);
    });
  });
});
