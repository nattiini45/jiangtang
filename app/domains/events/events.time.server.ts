import { berlinLocalToUtc } from "~/lib/time.server";
import { matchingEventInstant } from "./events.time";

export function resolveEventTime(local: string, instant?: string): Date {
  return matchingEventInstant(local, instant) ?? berlinLocalToUtc(local);
}
