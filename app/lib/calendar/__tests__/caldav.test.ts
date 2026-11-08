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
 * DTSTART / SEQUENCE), DELETE on remove (404/410 = already gone), non-2xx → throw,
 * the admin connection check, and the config-gated factory (Noop when CALDAV_*
 * unset).
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

  /** Sends the headers at once, then never finishes the body until aborted. */
  function stalledBody(status: number) {
    return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        },
      });
      return new Response(body, { status });
    });
  }

  it.each([
    ["an error response", (pub: CalDavPublisher) => pub.upsert(payload()), 500],
    ["a PROPFIND answer", (pub: CalDavPublisher) => pub.check(), 207],
  ])("keeps the timeout while reading %s whose body stalls", async (_name, call, status) => {
    vi.useFakeTimers();
    try {
      const pub = new CalDavPublisher(CONFIG, stalledBody(status));
      let settled = false;
      const pending = call(pub).then(
        (v) => ((settled = true), v),
        (e: unknown) => {
          settled = true;
          return e;
        },
      );
      await vi.advanceTimersByTimeAsync(CALDAV_REQUEST_TIMEOUT_MS);
      await pending;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CalDavPublisher.remove", () => {
  it("DELETEs the event's resource with Basic auth and no body", async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    const pub = new CalDavPublisher(CONFIG, fetchImpl);
    await pub.remove("evt-abc");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://dav.example.org/cal/av/evt-abc.ics");
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("svc:s3cret").toString("base64")}`);
  });

  it.each([404, 410])("treats %i (already gone) as success", async (status) => {
    const pub = new CalDavPublisher(CONFIG, mockFetch(new Response("", { status })));
    await expect(pub.remove("evt-abc")).resolves.toBeUndefined();
  });

  it("throws on any other non-2xx response so the outbox retries", async () => {
    const pub = new CalDavPublisher(CONFIG, mockFetch(new Response("locked", { status: 423 })));
    await expect(pub.remove("evt-abc")).rejects.toThrow(/DELETE .*423/);
  });
});

/** A Depth: 0 PROPFIND answer shaped like Nextcloud's for a calendar collection. */
function multistatus(resourcetype: string, privileges: string, displayName = "AV-Termine"): string {
  return `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/calendars/svc/av/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype>${resourcetype}</d:resourcetype>
        <d:displayname>${displayName}</d:displayname>
        <d:current-user-privilege-set>${privileges}</d:current-user-privilege-set>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
}

const CALENDAR = "<d:collection/><cal:calendar/>";
const WRITE = "<d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege>";
const READ_ONLY =
  "<d:privilege><d:read/></d:privilege><d:privilege><d:write-properties/></d:privilege>";

describe("CalDavPublisher.check", () => {
  it("PROPFINDs the collection at depth 0 and accepts a writable calendar", async () => {
    const fetchImpl = mockFetch(new Response(multistatus(CALENDAR, WRITE), { status: 207 }));
    const result = await new CalDavPublisher(CONFIG, fetchImpl).check();

    expect(result).toEqual({ ok: true, displayName: "AV-Termine" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(CONFIG.url);
    expect(init?.method).toBe("PROPFIND");
    expect((init?.headers as Record<string, string>).Depth).toBe("0");
  });

  it.each([
    ["unauthorized", new Response("", { status: 401 })],
    ["notFound", new Response("", { status: 404 })],
    ["http", new Response("oops", { status: 500 })],
    ["notCalendar", new Response(multistatus("<d:collection/>", WRITE), { status: 207 })],
    ["readOnly", new Response(multistatus(CALENDAR, READ_ONLY), { status: 207 })],
  ])("reports %s", async (reason, response) => {
    const result = await new CalDavPublisher(CONFIG, mockFetch(response)).check();
    expect(result).toMatchObject({ ok: false, reason });
  });

  it("reports an unreachable server as a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const result = await new CalDavPublisher(CONFIG, fetchImpl).check();
    expect(result).toEqual({ ok: false, reason: "network", detail: "fetch failed" });
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
