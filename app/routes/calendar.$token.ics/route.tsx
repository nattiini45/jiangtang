import type { Route } from "./+types/route";
import { getFeedToken, tokenMatches } from "~/lib/calendar/ical-token.server";
import { loadFeedEvents, renderIcalFeed } from "~/lib/calendar/ical.server";

/**
 * Token-gated, self-hosted `.ics` feed of AV-supported events (an iCal bonus).
 * Public-but-token-gated because calendar
 * clients subscribe without cookies — the token lives in the URL. A wrong token
 * returns a 404 (don't reveal it's an auth wall) to avoid enumeration.
 *
 * The feed is generated on demand from live Event rows + the latest outbox
 * SEQUENCE per uid; the outbox feeds the CalDAV push.
 */
export async function loader({ params }: Route.LoaderArgs) {
  const expected = getFeedToken();
  const presented = params.token ?? "";
  if (!tokenMatches(expected, presented)) {
    throw new Response("Not Found", { status: 404 });
  }

  const events = await loadFeedEvents();
  const body = renderIcalFeed(events);
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // Calendars re-poll periodically; let the CDN/proxy revalidate.
      "Cache-Control": "public, max-age=300",
    },
  });
}
