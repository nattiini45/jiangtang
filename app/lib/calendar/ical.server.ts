import ical, { ICalEventStatus } from "ical-generator";
import { db } from "~/lib/db.server";
import { t } from "~/i18n";
import { workspaceLocale } from "~/i18n/locale.server";

/**
 * iCal rendering for both halves: the pull feed (a `.ics`
 * VCALENDAR of live Event rows rendered on demand) and the per-event object
 * bodies the CalDavPublisher PUTs when draining the transactional outbox.
 * Both go through the same `buildCalendar` so feed and push can never drift.
 * SEQUENCE is taken from the latest CalendarOutbox row per event uid so the
 * feed is consistent with what the CalDAV server receives.
 *
 * `Europe/Berlin` with an embedded VTIMEZONE so the output is correct across
 * DST boundaries and readable by clients without a tz database
 * ("validates/updates/cancels in Outlook + a non-MS
 * client").
 */

export interface ICalFeedEvent {
  uid: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  /** Latest CalendarOutbox sequence for this event's uid (for SEQUENCE). */
  sequence: number;
  cancelled: boolean;
}

/** Load non-cancelled events with their room location + latest outbox sequence. */
export async function loadFeedEvents(opts?: { from?: Date; to?: Date }): Promise<ICalFeedEvent[]> {
  const from = opts?.from ?? new Date(Date.now() - 1000 * 60 * 60 * 24 * 365);
  const to = opts?.to ?? new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);

  const events = await db.event.findMany({
    where: { startsAt: { gte: from, lt: to } },
    include: {
      rooms: {
        where: { cancelled: false },
        include: { room: { select: { name: true } } },
        orderBy: { startsAt: "asc" },
      },
    },
    orderBy: { startsAt: "asc" },
  });

  // Latest outbox sequence per uid (one query, reduce in app).
  const uids = events.map((e) => e.uid);
  const outbox = uids.length
    ? await db.calendarOutbox.findMany({
        where: { eventUid: { in: uids } },
        orderBy: { sequence: "desc" },
        select: { eventUid: true, sequence: true },
      })
    : [];
  const seqByUid = new Map<string, number>();
  for (const row of outbox) {
    if (!seqByUid.has(row.eventUid)) seqByUid.set(row.eventUid, row.sequence);
  }

  return events.map((e) => {
    const roomNames = [...new Set(e.rooms.map((b) => b.room.name))];
    return {
      uid: e.uid,
      title: e.title,
      description: e.description,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      location: roomNames.length ? roomNames.join(", ") : null,
      sequence: seqByUid.get(e.uid) ?? 0,
      cancelled: e.status === "CANCELLED",
    };
  });
}

/**
 * One VCALENDAR from N events. Cancelled events are emitted as a CANCELLED
 * VEVENT (STATUS:CANCELLED) rather than omitted — so subscribers see the
 * cancellation land in their client ("cancels in Outlook + a
 * non-MS client").
 */
function buildCalendar(events: ICalFeedEvent[], name?: string): string {
  const calendar = ical({
    ...(name ? { name } : {}),
    timezone: {
      name: "Europe/Berlin",
      // Embed a static VTIMEZONE for Europe/Berlin so the feed is self-contained
      // and DST-correct for clients that don't carry a tz database. Current EU
      // rules: CET (UTC+1) winter, CEST (UTC+2) summer; transitions last Sun of
      // March (02:00→03:00) and October (03:00→02:00).
      generator: () => BERLIN_VTIMEZONE,
    },
    events: events.map((e) => ({
      id: e.uid,
      sequence: e.sequence,
      start: e.startsAt,
      end: e.endsAt,
      summary: e.title,
      description: e.description ?? undefined,
      location: e.location ?? undefined,
      timezone: "Europe/Berlin",
      ...(e.cancelled ? { status: ICalEventStatus.CANCELLED } : {}),
    })),
  });
  return calendar.toString();
}

/** Build the multi-event `.ics` feed document. */
export function renderIcalFeed(events: ICalFeedEvent[]): string {
  return buildCalendar(events, t(workspaceLocale(), "calendar.feedName"));
}

/**
 * Build a single-VEVENT VCALENDAR — the body the CalDavPublisher PUTs to
 * `<collection>/<uid>.ics`. No calendar name: object resources carry only the
 * event; the collection is named server-side.
 */
export function renderIcalObject(event: ICalFeedEvent): string {
  return buildCalendar([event]);
}

// A correct, self-contained Europe/Berlin VTIMEZONE (EU 1996+ DST rules).
// Returned by the generator above so the feed carries STANDARD + DAYLIGHT blocks.
const BERLIN_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
].join("\r\n");
