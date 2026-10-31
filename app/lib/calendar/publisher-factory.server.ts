import { NoopPublisher, type CalendarPublisher } from "~/lib/calendar/publisher.server";
import { CalDavPublisher, getCalDavConfig } from "~/lib/calendar/caldav.server";

/**
 * The ONE config-gating point for calendar publishing: a real CalDavPublisher
 * when CALDAV_* is fully configured, else the NoopPublisher. Both the drain
 * worker (calendar.boot) and any ad-hoc caller go through here, so "is the
 * calendar wired?" is decided in exactly one place.
 */
export function getPublisher(): CalendarPublisher {
  const config = getCalDavConfig();
  return config ? new CalDavPublisher(config) : new NoopPublisher();
}
