import { z } from "zod";
import { berlinLocalString, berlinOffsetMs } from "~/lib/berlin-days";

export const eventInstantSchema = z.iso.datetime();

export function matchingEventInstant(local: string, value?: string): Date | undefined {
  if (!eventInstantSchema.safeParse(value).success) return undefined;
  const instant = new Date(value!);
  return berlinLocalString(instant).replace(" ", "T") === local ? instant : undefined;
}

export function eventTimeMs(local: string, value?: string): number {
  const instant = matchingEventInstant(local, value);
  if (instant) return instant.getTime();
  const naive = new Date(`${local.length === 16 ? `${local}:00` : local}Z`).getTime();
  if (!Number.isFinite(naive)) return NaN;
  const first = naive - berlinOffsetMs(naive);
  return naive - berlinOffsetMs(first);
}
