import type { CalendarPayload, CalendarPublisher } from "~/lib/calendar/publisher.server";
import { renderIcalObject, type ICalFeedEvent } from "~/lib/calendar/ical.server";

/**
 * CalDAV publisher — the concrete CalendarPublisher the outbox worker drains
 * to. Targets a plain CalDAV collection (Nextcloud / SOGo / Radicale /
 * Baïkal); there is no Exchange/Graph path. Calendar downtime
 * must never block app writes, so mutations only enqueue outbox rows in-tx — this
 * client is invoked out-of-band by the drain worker.
 *
 * Object-level model: one `.ics` resource per event UID at
 * `<collection>/<uid>.ics`. We are the calendar's ONLY writer, so the concurrency
 * model is deliberate last-write-wins: every upsert is an UNCONDITIONAL PUT (no
 * ETags, no If-Match). Ordering across concurrent app mutations is already
 * serialized upstream by the per-uid advisory lock + monotonic iCal SEQUENCE, and
 * the drain worker dispatches a uid's sequences strictly in order — so the object
 * on the server always ends up carrying the highest SEQUENCE.
 *
 * Library note: publish-only CalDAV needs nothing beyond authenticated PUT and
 * DELETE, so this is a deliberate zero-dependency client on global `fetch` —
 * Basic auth, server-agnostic, with an injectable fetch for HTTP-mocked tests. No
 * discovery is needed: the collection URL is supplied directly via CALDAV_URL. The
 * only PROPFIND is the admin connection check.
 */

import type { CalDavConfig } from "~/lib/calendar/config.server";
export { getCalDavConfig } from "~/lib/calendar/config.server";
export type { CalDavConfig } from "~/lib/calendar/config.server";

/** Injectable fetch — tests pass a mock; production uses global `fetch`. */
export type FetchLike = typeof fetch;

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** Join the collection URL and a resource name, tolerating a trailing slash. */
function resourceUrl(collection: string, uid: string): string {
  const base = collection.endsWith("/") ? collection : `${collection}/`;
  // Encode the uid so a colon/slash inside a cuid-shaped uid can't break the path.
  return `${base}${encodeURIComponent(uid)}.ics`;
}

function payloadToFeedEvent(payload: CalendarPayload): ICalFeedEvent {
  return {
    uid: payload.uid,
    title: payload.title,
    description: payload.description ?? null,
    startsAt: payload.startsAt,
    endsAt: payload.endsAt,
    location: payload.location ?? null,
    sequence: payload.sequence,
    cancelled: false,
  };
}

/**
 * Upper bound for one request. The outbox drain holds its cross-instance lock for
 * a bounded time, so a server that never answers must not keep a push in flight
 * past it. A timed-out request counts as failed and is retried with backoff.
 */
export const CALDAV_REQUEST_TIMEOUT_MS = 60_000;

/** Outcome of the admin connection check against the configured collection. */
export type CalDavCheck =
  | { ok: true; displayName: string | null }
  | {
      ok: false;
      reason: "unauthorized" | "notFound" | "notCalendar" | "readOnly" | "http" | "network";
      detail: string;
    };

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
  </d:prop>
</d:propfind>`;

function xmlText(xml: string, element: string): string | null {
  const match = new RegExp(
    `<(?:[\\w-]+:)?${element}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${element}>`,
  ).exec(xml);
  return match ? match[1] : null;
}

export class CalDavPublisher implements CalendarPublisher {
  constructor(
    private readonly config: CalDavConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async upsert(payload: CalendarPayload): Promise<void> {
    const url = resourceUrl(this.config.url, payload.uid);
    await this.request(
      url,
      {
        method: "PUT",
        headers: { "Content-Type": "text/calendar; charset=utf-8" },
        body: renderIcalObject(payloadToFeedEvent(payload)),
      },
      (res) => this.throwUnlessOk(res, "PUT", url),
    );
  }

  /**
   * Deletes the event's resource, so a removed or cancelled event disappears from
   * the calendar instead of lingering there as a cancelled entry. A resource that
   * is already gone (404, or 410 on some servers) is the desired end state.
   */
  async remove(uid: string): Promise<void> {
    const url = resourceUrl(this.config.url, uid);
    await this.request(url, { method: "DELETE" }, async (res) => {
      if (res.status === 404 || res.status === 410) return;
      await this.throwUnlessOk(res, "DELETE", url);
    });
  }

  /**
   * Checks that the configured URL is a calendar collection these credentials can
   * write to, without touching any event. Servers that do not report privileges
   * are given the benefit of the doubt.
   */
  async check(): Promise<CalDavCheck> {
    let status: number;
    let text: string;
    try {
      ({ status, text } = await this.request(
        this.config.url,
        {
          method: "PROPFIND",
          headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
          body: PROPFIND_BODY,
        },
        async (res) => ({ status: res.status, text: await res.text() }),
      ));
    } catch (e) {
      return { ok: false, reason: "network", detail: (e as Error).message };
    }
    if (status === 401 || status === 403) {
      return { ok: false, reason: "unauthorized", detail: `HTTP ${status}` };
    }
    if (status === 404) return { ok: false, reason: "notFound", detail: "HTTP 404" };
    if (status !== 207) {
      return { ok: false, reason: "http", detail: `HTTP ${status}: ${text.slice(0, 200)}` };
    }
    const resourceType = xmlText(text, "resourcetype") ?? "";
    if (!/<(?:[\w-]+:)?calendar[\s/>]/.test(resourceType)) {
      return { ok: false, reason: "notCalendar", detail: resourceType.trim().slice(0, 200) };
    }
    const privileges = xmlText(text, "current-user-privilege-set");
    if (
      privileges !== null &&
      !/<(?:[\w-]+:)?(?:write|write-content|bind|all)[\s/>]/.test(privileges)
    ) {
      return { ok: false, reason: "readOnly", detail: privileges.trim().slice(0, 200) };
    }
    return { ok: true, displayName: xmlText(text, "displayname")?.trim() || null };
  }

  /** Sends one request and consumes its response, both within the timeout. */
  private async request<T>(
    url: string,
    init: RequestInit,
    consume: (res: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CALDAV_REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: basicAuthHeader(this.config.username, this.config.password),
        },
        signal: controller.signal,
      });
      return await consume(res);
    } finally {
      clearTimeout(timer);
    }
  }

  private async throwUnlessOk(res: Response, method: string, url: string): Promise<void> {
    if (res.ok) return;
    // Include a short snippet of the response for operator diagnosis, but keep it
    // bounded — outbox.lastError is truncated too, and a server may echo HTML.
    const text = await res.text().catch(() => "");
    throw new Error(`CalDAV ${method} ${url} → ${res.status}: ${text.slice(0, 200)}`);
  }
}
