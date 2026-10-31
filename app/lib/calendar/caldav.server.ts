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
 * Library note: publish-only CalDAV needs nothing beyond authenticated PUTs, so
 * this is a deliberate zero-dependency client on global `fetch` — PUT only, Basic
 * auth, server-agnostic, with an injectable fetch for HTTP-mocked tests. No
 * discovery/PROPFIND is needed: the collection URL is supplied directly via
 * CALDAV_URL.
 */

export interface CalDavConfig {
  /** The calendar COLLECTION url (e.g. https://dav.example.org/cal/av-events/). */
  url: string;
  username: string;
  password: string;
}

/**
 * Read CalDAV config from the environment. Returns null if any of the three vars
 * is missing/empty — the single signal the factory uses to fall back to Noop.
 */
export function getCalDavConfig(): CalDavConfig | null {
  const url = process.env.CALDAV_URL?.trim();
  const username = process.env.CALDAV_USERNAME?.trim();
  const password = process.env.CALDAV_PASSWORD;
  if (!url || !username || !password) return null;
  return { url, username, password };
}

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

/**
 * Build the single-VEVENT `.ics` PUT body via the shared per-event renderer —
 * so the VTIMEZONE, SEQUENCE and STATUS:CANCELLED handling stays identical to
 * the pull feed (the golden-rule iCal path). `cancelled` maps a REMOVE to a
 * STATUS:CANCELLED VEVENT (parity with the feed, which renders cancellations
 * rather than omitting them).
 */
function icalBody(event: ICalFeedEvent): string {
  return renderIcalObject(event);
}

function payloadToFeedEvent(payload: CalendarPayload, cancelled: boolean): ICalFeedEvent {
  return {
    uid: payload.uid,
    title: payload.title,
    description: payload.description ?? null,
    startsAt: payload.startsAt,
    endsAt: payload.endsAt,
    location: payload.location ?? null,
    sequence: payload.sequence,
    cancelled,
  };
}

export class CalDavPublisher implements CalendarPublisher {
  constructor(
    private readonly config: CalDavConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async upsert(payload: CalendarPayload): Promise<void> {
    await this.put(payload.uid, icalBody(payloadToFeedEvent(payload, false)));
  }

  async remove(uid: string, sequence: number): Promise<void> {
    // We don't retain the full payload for a REMOVE, so synthesize a minimal
    // cancelled VEVENT: a valid CANCELLED entry only needs uid + times + SEQUENCE.
    // Parity with the iCal feed, which emits STATUS:CANCELLED rather than deleting.
    const now = new Date();
    const body = icalBody({
      uid,
      title: "",
      description: null,
      startsAt: now,
      endsAt: now,
      location: null,
      sequence,
      cancelled: true,
    });
    await this.put(uid, body);
  }

  /** Unconditional PUT of an `.ics` resource; non-2xx throws. */
  private async put(uid: string, body: string): Promise<void> {
    const url = resourceUrl(this.config.url, uid);
    const res = await this.fetchImpl(url, {
      method: "PUT",
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        Authorization: basicAuthHeader(this.config.username, this.config.password),
      },
      body,
    });
    if (!res.ok) {
      // Include a short snippet of the response for operator diagnosis, but keep it
      // bounded — outbox.lastError is truncated too, and a server may echo HTML.
      const text = await res.text().catch(() => "");
      throw new Error(`CalDAV PUT ${url} → ${res.status}: ${text.slice(0, 200)}`);
    }
  }
}
